import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { headOf } from "../server/git";
import { findRepoRoot, ProjectRegistry, projectSlug } from "../server/projects";
import { initRepo, sh, tmpDir } from "./helpers";

function withOrigin(name?: string): string { const r = initRepo(name); sh(r, "git", ["remote", "add", "origin", join(tmpDir(), "o.git")]); return r; }
const registry = (file = join(tmpDir(), "projects.json"), log?: (m: string) => void) => new ProjectRegistry(file, log);

describe("findRepoRoot and projectSlug", () => {
  it("walks up from a subfolder to the folder holding .git, telling a main checkout from a worktree", () => {
    const r = initRepo(); mkdirSync(join(r, "a", "b"), { recursive: true });
    expect(findRepoRoot(join(r, "a", "b"))).toEqual({ root: r, dotGit: "dir" });
    const wt = join(tmpDir(), "wt"); sh(r, "git", ["worktree", "add", "-q", "-b", "x", wt]);
    expect(findRepoRoot(wt)).toEqual({ root: wt, dotGit: "file" });
    expect(findRepoRoot(tmpDir())).toBeNull();
  });
  it("names a project after its folder, lower case, other characters as -", () => {
    expect(projectSlug("/x/My App")).toBe("my-app");
    expect(projectSlug("/x/beepo")).toBe("beepo");
    expect(projectSlug("/x/Ứng dụng")).toBe("ng-d-ng");
    expect(projectSlug("/x/___")).toBe("repo");
  });
});

describe("ProjectRegistry.register (rev 5.11)", () => {
  it("registers the repo of a subfolder under its folder name, trusts it, and writes projects.json", () => {
    const r = withOrigin("My App"); mkdirSync(join(r, "src"));
    const file = join(tmpDir(), "projects.json");
    expect(registry(file).register(join(r, "src"), "origin")).toEqual({ name: "my-app", repo: r });
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ "my-app": { repo: r } });
    expect(() => headOf(r)).not.toThrow();
  });
  it("gives the same name to the same repo, through a symlink too, and a hashed name to another repo with the same folder name", () => {
    const reg = registry();
    const a = withOrigin("api"); const b = withOrigin("api");
    const link = join(tmpDir(), "link"); symlinkSync(a, link);
    expect(reg.register(a, "origin").name).toBe("api");
    expect(reg.register(link, "origin").name).toBe("api");
    expect(reg.register(b, "origin").name).toMatch(/^api-[0-9a-f]{4}$/);
    expect(reg.register(b, "origin").name).toBe(reg.register(b, "origin").name);
  });
  it("refuses a folder outside any git repo, a worktree, a repo with command-running git drivers, and a repo without the remote, saying how to fix each", () => {
    const reg = registry();
    expect(() => reg.register(tmpDir(), "origin")).toThrow(/not inside a git repo/);
    const r = withOrigin(); const wt = join(tmpDir(), "wt"); sh(r, "git", ["worktree", "add", "-q", "-b", "x", wt]);
    expect(() => reg.register(wt, "origin")).toThrow(/open the repo's main checkout/i);
    const d = withOrigin(); sh(d, "git", ["config", "filter.fmt.clean", "node x.js"]);
    expect(() => reg.register(d, "origin")).toThrow(/filter\.fmt\.clean/);
    expect(() => reg.register(initRepo(), "origin")).toThrow(/no remote "origin".*push the repo to a remote first/i);
    expect(reg.names()).toEqual([]);
  });
  it("comes back after a restart: a new registry reads the file and trusts its repos again, logging and skipping one that is gone", () => {
    const file = join(tmpDir(), "projects.json");
    const keep = withOrigin("keep"); const gone = withOrigin("gone");
    const first = registry(file); first.register(keep, "origin"); first.register(gone, "origin");
    rmSync(gone, { recursive: true, force: true });
    const logs: string[] = [];
    const again = registry(file, (m) => logs.push(m)); again.trustAll();
    expect(again.get("keep")).toEqual({ repo: keep });
    expect(again.names().sort()).toEqual(["gone", "keep"]);
    expect(logs.join("\n")).toMatch(/project gone: .*skipped/);
  });
  it("keeps a corrupt projects.json aside instead of losing it", () => {
    const file = join(tmpDir(), "projects.json"); writeFileSync(file, "{ not json");
    const logs: string[] = [];
    const reg = registry(file, (m) => logs.push(m));
    expect(reg.names()).toEqual([]);
    expect(logs.join("\n")).toMatch(/projects\.json is not valid JSON/);
    reg.register(withOrigin("fresh"), "origin");
    expect(existsSync(`${file}.bad`)).toBe(true);
    expect(readFileSync(`${file}.bad`, "utf8")).toBe("{ not json");
  });
});
