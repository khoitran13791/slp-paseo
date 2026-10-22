import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EventStore } from "./events";

export class StoreRegistry {
  private readonly cache = new Map<string, EventStore>();
  constructor(readonly home: string) {}

  private store(file: string, feature: string | null): EventStore {
    let s = this.cache.get(file);
    if (!s) {
      s = new EventStore(file);
      this.cache.set(file, s);
      if (s.truncatedTail !== null) s.append({ feature, kind: "ops", by_role: "plugin", by_agent: null, data: { type: "log_truncated", summary: `dropped an incomplete last line (${s.truncatedTail.length} chars)` } });
    }
    return s;
  }
  file(project: string, name: string): string { return join(this.home, project, name); }
  featureDir(project: string, feature: string): string { return join(this.home, project, "features", feature); }
  project(project: string): EventStore { return this.store(join(this.home, project, "project.jsonl"), null); }
  feature(project: string, feature: string): EventStore { return this.store(join(this.featureDir(project, feature), "events.jsonl"), feature); }
  features(project: string): string[] {
    const dir = join(this.home, project, "features");
    return existsSync(dir) ? readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name).sort() : [];
  }
  writeDoc(project: string, feature: string, kind: "brief" | "spec" | "plan", content: string): { version: number; path: string; sha256: string } {
    const dir = this.featureDir(project, feature);
    mkdirSync(dir, { recursive: true });
    let version = 1;
    while (existsSync(join(dir, `${kind}.v${version}.md`))) version += 1;
    const path = join(dir, `${kind}.v${version}.md`);
    writeFileSync(path, content, { flag: "wx", mode: 0o600 });
    return { version, path, sha256: createHash("sha256").update(content).digest("hex") };
  }
  readDoc(path: string): string { return readFileSync(path, "utf8"); }
  writeDigest(project: string, feature: string, text: string): void {
    mkdirSync(this.featureDir(project, feature), { recursive: true });
    writeFileSync(join(this.featureDir(project, feature), "digest.md"), text, { mode: 0o600 });
  }
  readDigest(project: string, feature: string): string {
    const p = join(this.featureDir(project, feature), "digest.md");
    return existsSync(p) ? readFileSync(p, "utf8") : `# ${feature} — no events yet\n`;
  }
  writeReport(project: string, feature: string, task: string, content: string): string {
    const dir = join(this.featureDir(project, feature), "reports");
    mkdirSync(dir, { recursive: true });
    let n = 1;
    while (existsSync(join(dir, `${task}-${n}.md`))) n += 1;
    const path = join(dir, `${task}-${n}.md`);
    writeFileSync(path, content, { mode: 0o600 });
    return path;
  }
}
