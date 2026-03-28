import { randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import { toFile, type Uploadable } from "openai/uploads";

import type {
  CuratedSkillCatalogEntry,
  SkillBundle,
  SkillSource,
  StoredFile,
} from "@/lib/types";

const SKILLS_ROOT_DIR = path.join(process.cwd(), "data", "skills");
const CURATED_SKILLS_WEB_ROOT = "https://github.com/openai/skills/tree/main/skills/.curated";
const CURATED_SKILLS_API_ROOT = "https://api.github.com/repos/openai/skills/contents/skills/.curated";
const CURATED_SKILLS_RAW_ROOT = "https://raw.githubusercontent.com/openai/skills/main/skills/.curated";
const GITHUB_HEADERS = {
  Accept: "application/vnd.github+json",
  "User-Agent": "agent-containers",
};
const CATALOG_CACHE_TTL_MS = 1000 * 60 * 30;

type GitHubContentEntry = {
  name: string;
  path: string;
  type: "file" | "dir";
  download_url: string | null;
};

let curatedCatalogCache:
  | {
      expiresAt: number;
      entries: CuratedSkillCatalogEntry[];
    }
  | undefined;

function titleFromSlug(slug: string) {
  return slug
    .split("-")
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function encodeGithubPath(pathname: string) {
  return pathname
    .split("/")
    .filter(Boolean)
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

async function fetchJson<T>(url: string) {
  const response = await fetch(url, { headers: GITHUB_HEADERS });

  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status})`);
  }

  return (await response.json()) as T;
}

async function fetchText(url: string) {
  const response = await fetch(url, { headers: GITHUB_HEADERS });

  if (!response.ok) {
    throw new Error(`GitHub request failed (${response.status})`);
  }

  return response.text();
}

function parseFrontmatterValue(rawValue: string) {
  const value = rawValue.trim();

  if (!value) {
    return "";
  }

  if (value.startsWith("\"") && value.endsWith("\"")) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }

  if (value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1).replaceAll("''", "'");
  }

  return value;
}

export function parseSkillManifest(source: string) {
  const match = source.match(/^---\s*\n([\s\S]*?)\n---\s*/);

  if (!match) {
    return { name: "", description: "" };
  }

  const manifest = { name: "", description: "" };

  for (const line of match[1].split(/\r?\n/)) {
    const separatorIndex = line.indexOf(":");

    if (separatorIndex === -1) {
      continue;
    }

    const key = line.slice(0, separatorIndex).trim();
    const value = parseFrontmatterValue(line.slice(separatorIndex + 1));

    if (key === "name") {
      manifest.name = value;
    }

    if (key === "description") {
      manifest.description = value;
    }
  }

  return manifest;
}

function buildSkillMarkdown(input: {
  name: string;
  description: string;
  instructions: string;
}) {
  return [
    "---",
    `name: ${JSON.stringify(input.name)}`,
    `description: ${JSON.stringify(input.description)}`,
    "---",
    "",
    input.instructions.trim(),
    "",
  ].join("\n");
}

async function collectSkillFiles(rootDir: string, currentDir = rootDir): Promise<StoredFile[]> {
  const entries = await readdir(currentDir, { withFileTypes: true });
  const files: StoredFile[] = [];

  for (const entry of entries) {
    const diskPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      files.push(...(await collectSkillFiles(rootDir, diskPath)));
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const details = await stat(diskPath);
    const relativePath = path.relative(rootDir, diskPath).replaceAll(path.sep, "/");

    files.push({
      id: randomUUID(),
      name: path.basename(relativePath),
      relativePath,
      diskPath,
      size: details.size,
    });
  }

  return files.sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

async function buildDirectorySkillRecord(input: {
  id?: string;
  rootDir: string;
  name: string;
  description: string;
  slug: string;
  source: SkillSource;
  originUrl?: string;
}) {
  const timestamp = new Date().toISOString();
  const files = await collectSkillFiles(input.rootDir);

  return {
    id: input.id ?? randomUUID(),
    name: input.name,
    description: input.description,
    slug: input.slug,
    source: input.source,
    filename: path.basename(input.rootDir),
    diskPath: input.rootDir,
    format: "directory",
    files,
    originUrl: input.originUrl,
    createdAt: timestamp,
    updatedAt: timestamp,
  } satisfies SkillBundle;
}

async function fetchGitHubDirectory(pathname: string) {
  return fetchJson<GitHubContentEntry[]>(`${CURATED_SKILLS_API_ROOT}/${encodeGithubPath(pathname)}`);
}

async function downloadGitHubDirectory(pathname: string, destinationRoot: string, prefix = ""): Promise<void> {
  const entries = await fetchGitHubDirectory(pathname);

  for (const entry of entries) {
    const nextRelativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

    if (entry.type === "dir") {
      await downloadGitHubDirectory(`${pathname}/${entry.name}`, destinationRoot, nextRelativePath);
      continue;
    }

    if (!entry.download_url) {
      continue;
    }

    const fileResponse = await fetch(entry.download_url, { headers: GITHUB_HEADERS });

    if (!fileResponse.ok) {
      throw new Error(`Failed to download ${entry.path} (${fileResponse.status})`);
    }

    const diskPath = path.join(destinationRoot, nextRelativePath);

    await mkdir(path.dirname(diskPath), { recursive: true });
    await writeFile(diskPath, Buffer.from(await fileResponse.arrayBuffer()));
  }
}

export function slugifySkillName(name: string) {
  return (
    name
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "skill"
  );
}

function buildSkillUploadPath(skill: SkillBundle, relativePath: string) {
  const uploadRoot = slugifySkillName(skill.slug || skill.name || "skill");
  const normalizedRelativePath = relativePath.replaceAll("\\", "/").replace(/^\/+/, "");

  return path.posix.join(uploadRoot, normalizedRelativePath);
}

export async function listCuratedSkills() {
  if (curatedCatalogCache && curatedCatalogCache.expiresAt > Date.now()) {
    return curatedCatalogCache.entries;
  }

  const entries = await fetchJson<GitHubContentEntry[]>(CURATED_SKILLS_API_ROOT);
  const directories = entries.filter((entry) => entry.type === "dir");
  const curatedSkills = await Promise.all(
    directories.map(async (entry) => {
      try {
        const skillSource = await fetchText(`${CURATED_SKILLS_RAW_ROOT}/${entry.name}/SKILL.md`);
        const manifest = parseSkillManifest(skillSource);

        return {
          slug: entry.name,
          name: manifest.name || titleFromSlug(entry.name),
          description: manifest.description,
          sourceUrl: `${CURATED_SKILLS_WEB_ROOT}/${entry.name}`,
        } satisfies CuratedSkillCatalogEntry;
      } catch {
        return {
          slug: entry.name,
          name: titleFromSlug(entry.name),
          description: "",
          sourceUrl: `${CURATED_SKILLS_WEB_ROOT}/${entry.name}`,
        } satisfies CuratedSkillCatalogEntry;
      }
    }),
  );

  curatedCatalogCache = {
    expiresAt: Date.now() + CATALOG_CACHE_TTL_MS,
    entries: curatedSkills.sort((left, right) => left.name.localeCompare(right.name)),
  };

  return curatedCatalogCache.entries;
}

export async function createManualSkillRecord(input: {
  name: string;
  description: string;
  instructions: string;
}) {
  const skillId = randomUUID();
  const rootDir = path.join(SKILLS_ROOT_DIR, skillId);
  const skillMarkdown = buildSkillMarkdown(input);

  await mkdir(rootDir, { recursive: true });
  await writeFile(path.join(rootDir, "SKILL.md"), skillMarkdown, "utf8");

  return buildDirectorySkillRecord({
    id: skillId,
    rootDir,
    name: input.name.trim(),
    description: input.description.trim(),
    slug: slugifySkillName(input.name),
    source: "manual",
  });
}

export async function installCuratedSkillRecord(slug: string) {
  const skillId = randomUUID();
  const rootDir = path.join(SKILLS_ROOT_DIR, skillId);
  const repoPath = slug.trim();

  await mkdir(rootDir, { recursive: true });

  try {
    await downloadGitHubDirectory(repoPath, rootDir);
    const skillMarkdown = await readFile(path.join(rootDir, "SKILL.md"), "utf8");
    const manifest = parseSkillManifest(skillMarkdown);

    return await buildDirectorySkillRecord({
      id: skillId,
      rootDir,
      name: manifest.name || titleFromSlug(repoPath),
      description: manifest.description,
      slug: repoPath,
      source: "curated",
      originUrl: `${CURATED_SKILLS_WEB_ROOT}/${repoPath}`,
    });
  } catch (error) {
    await rm(rootDir, { recursive: true, force: true });
    throw error;
  }
}

export async function getSkillUploadables(skill: SkillBundle): Promise<Uploadable | Uploadable[]> {
  if (skill.format === "zip") {
    return toFile(createReadStream(skill.diskPath), skill.filename);
  }

  const files = skill.files.length ? skill.files : await collectSkillFiles(skill.diskPath);

  if (!files.length) {
    throw new Error(`Skill "${skill.name}" does not contain any files.`);
  }

  return Promise.all(
    files.map((file) =>
      toFile(createReadStream(file.diskPath), buildSkillUploadPath(skill, file.relativePath)),
    ),
  );
}

export function getSkillStorageRoot(skill: SkillBundle) {
  return skill.format === "zip" ? path.dirname(skill.diskPath) : skill.diskPath;
}

export function getManagedSkillsRoot() {
  return SKILLS_ROOT_DIR;
}
