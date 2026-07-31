/**
 * Workflow-shape gate (ported from the TUI's src/test/scripts/workflow-shape.test.ts,
 * itself ported from the SDK's approach).
 *
 * CI cannot run without pushing, so this suite is the local proof that the
 * hand-authored workflow YAML is well-formed: the job graphs, needs edges, no
 * continue-on-error on any job, timeout caps, pinned action SHAs, and the
 * by-reference release wiring — including that release.yml consumes the SDK's
 * reusable workflows at mgd34msu/goodvibes-sdk@main. This repo ships a single
 * npm package (goodvibes-daemon) — no platform-specific sub-packages, no
 * GitHub Packages mirror — so its job graph is smaller than the TUI's.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const WF_DIR = resolve(ROOT, ".github/workflows");

type Job = Record<string, unknown> & {
  needs?: string | string[];
  "runs-on"?: string;
  "timeout-minutes"?: number;
  uses?: string;
  if?: unknown;
  steps?: Array<Record<string, unknown>>;
  permissions?: Record<string, string>;
};
type Workflow = { on?: unknown; jobs?: Record<string, Job>; concurrency?: Record<string, unknown> };

function load(name: string): Workflow {
  return Bun.YAML.parse(readFileSync(resolve(WF_DIR, name), "utf8")) as Workflow;
}
function jobs(wf: Workflow): [string, Job][] {
  return Object.entries(wf.jobs ?? {});
}
function needsOf(job: Job): string[] {
  return Array.isArray(job.needs) ? job.needs : job.needs ? [job.needs] : [];
}
function steps(job: Job): Array<Record<string, unknown>> {
  return job.steps ?? [];
}
function stepText(job: Job): string {
  return steps(job)
    .map((s) => String(s.run ?? ""))
    .join("\n");
}

describe("all workflows: baseline hygiene", () => {
  const files = readdirSync(WF_DIR).filter((f) => f.endsWith(".yml"));

  test("at least the CI and Release workflows exist", () => {
    expect(files).toContain("ci.yml");
    expect(files).toContain("release.yml");
  });

  test("no job or step uses continue-on-error: true (per-job-green is the only green)", () => {
    for (const f of files) {
      const wf = load(f);
      for (const [, job] of jobs(wf)) {
        expect(job["continue-on-error"]).not.toBe(true);
        for (const step of steps(job)) expect(step["continue-on-error"]).not.toBe(true);
      }
    }
  });

  test("every executing job declares a timeout (reusable-workflow callers are exempt)", () => {
    for (const f of files) {
      const wf = load(f);
      for (const [name, job] of jobs(wf)) {
        if (job.uses) continue;
        expect(job["timeout-minutes"], `${f}:${name} needs timeout-minutes`).toBeGreaterThan(0);
      }
    }
  });

  test("all uses: references are SHA-pinned, a local path, or a reusable @main/@vN ref", () => {
    for (const f of files) {
      const wf = load(f);
      for (const [, job] of jobs(wf)) {
        const refs: string[] = [];
        if (typeof job.uses === "string") refs.push(job.uses);
        for (const step of steps(job)) if (typeof step.uses === "string") refs.push(step.uses);
        for (const ref of refs) {
          const ok = ref.startsWith("./") || /@[0-9a-f]{40}$/.test(ref) || /@(main|v\d)/.test(ref);
          expect(ok, `unpinned action ref: ${ref} in ${f}`).toBe(true);
        }
      }
    }
  });
});

describe("ci.yml: the gate graph", () => {
  const ci = load("ci.yml");
  const gatingJobs = ["typecheck", "test", "workflow-check", "build", "boot-smoke"];

  test("has the expected job set", () => {
    const names = jobs(ci).map(([n]) => n);
    for (const n of [...gatingJobs, "auto-release"]) {
      expect(names).toContain(n);
    }
  });

  test("the build job gates on the checks it depends on", () => {
    const build = ci.jobs!["build"]!;
    for (const dep of ["typecheck", "test", "workflow-check"]) {
      expect(needsOf(build)).toContain(dep);
    }
  });

  test("boot-smoke gates on build", () => {
    expect(needsOf(ci.jobs!["boot-smoke"]!)).toContain("build");
  });

  test("cancel-in-progress is scoped to pull requests only", () => {
    expect(String(ci.concurrency?.["cancel-in-progress"])).toContain("pull_request");
  });
});

describe("ci.yml: zero-touch auto-release", () => {
  const ci = load("ci.yml");
  const gatingJobs = ["typecheck", "test", "workflow-check", "build", "boot-smoke"];

  test("auto-release needs EVERY other ci.yml job (only runs when all are green)", () => {
    const auto = ci.jobs!["auto-release"]!;
    const needs = needsOf(auto);
    for (const job of gatingJobs) {
      expect(needs, `auto-release must need ${job} so it only runs when that gate is green`).toContain(job);
    }
    // And its needs set is exactly the other jobs — no gate omitted, no self-need.
    const otherJobs = jobs(ci)
      .map(([n]) => n)
      .filter((n) => n !== "auto-release");
    expect([...needs].sort()).toEqual([...otherJobs].sort());
  });

  test("auto-release is gated to pushes on main", () => {
    const cond = String(ci.jobs!["auto-release"]!.if);
    expect(cond).toContain("github.ref == 'refs/heads/main'");
    expect(cond).toContain("github.event_name == 'push'");
  });

  test("auto-release grants contents:write and actions:write", () => {
    const perms = ci.jobs!["auto-release"]!.permissions ?? {};
    expect(perms.contents).toBe("write");
    expect(perms.actions).toBe("write");
  });

  test("auto-release checks tag existence BEFORE creating the tag", () => {
    const text = stepText(ci.jobs!["auto-release"]!);
    const existenceCheck = text.indexOf("git ls-remote --tags origin");
    const tagCreate = text.indexOf("git tag -a");
    expect(existenceCheck).toBeGreaterThanOrEqual(0);
    expect(tagCreate).toBeGreaterThanOrEqual(0);
    // The idempotent existence check must precede tag creation.
    expect(existenceCheck).toBeLessThan(tagCreate);
  });

  test("auto-release dispatches release.yml with mode=release, not a bare tag push", () => {
    const text = stepText(ci.jobs!["auto-release"]!);
    expect(text).toContain("gh workflow run release.yml");
    expect(text).toContain("mode=release");
    // The dispatch uses the tag ref so github.ref/github.sha point at the tag.
    expect(text).toContain("--ref");
    expect(text).toContain("refs/tags/");
  });

  test("auto-release retries the dispatch on transient failure", () => {
    const text = stepText(ci.jobs!["auto-release"]!);
    expect(text).toContain("attempt");
    expect(text).toMatch(/sleep 7/);
  });
});

describe("release.yml: by-reference release on the reusable workflows", () => {
  const rel = load("release.yml");
  const REUSABLE = "mgd34msu/goodvibes-sdk/.github/workflows";

  test("verify-tag-version runs before release-verify and gates on push/release-mode dispatch", () => {
    const verify = rel.jobs!["verify-tag-version"]!;
    expect(String(verify.if)).toContain("github.event_name == 'push'");
    expect(String(verify.if)).toContain("inputs.mode == 'release'");

    const rv = rel.jobs!["release-verify"]!;
    expect(needsOf(rv)).toContain("verify-tag-version");
  });

  test("release-verify calls the reusable by-reference workflow at @main", () => {
    const rv = rel.jobs!["release-verify"]!;
    expect(rv.uses).toBe(`${REUSABLE}/reusable-release-verify.yml@main`);
    expect(String(rv.if)).toContain("github.event_name == 'push'");
  });

  test("caller jobs grant the permissions the called reusable workflows request", () => {
    // GitHub validates this at workflow startup: a called workflow's job may
    // only use permissions the caller job grants; an under-granting caller is
    // rejected with startup_failure and jobs: [] before anything runs. The
    // reusables' requested permissions are their documented contract:
    // release-verify reads run/job conclusions (actions+checks read),
    // gh-release creates the release (contents write), publish-npm mints
    // provenance (id-token write).
    const contract: Record<string, Record<string, string>> = {
      "release-verify": { actions: "read", checks: "read" },
      "gh-release": { contents: "write" },
      "publish-npm": { "id-token": "write" },
    };
    for (const [jobName, required] of Object.entries(contract)) {
      const job = rel.jobs![jobName]! as Job & { permissions?: Record<string, string> };
      for (const [scope, level] of Object.entries(required)) {
        expect(job.permissions?.[scope], `${jobName} must grant ${scope}: ${level}`).toBe(level);
      }
    }
  });

  test("the binary matrix calls the reusable workflow at @main", () => {
    expect(rel.jobs!["binaries"]!.uses).toBe(`${REUSABLE}/reusable-binary-matrix.yml@main`);
  });

  test("every smoke:true matrix leg carries its own binary path matching the config's appArtifact", () => {
    // reusable-binary-matrix contract: targets is {key, runner, smoke, binary}
    // and `binary` is REQUIRED when smoke is true — each leg only builds its
    // own suffixed artifact, so the smoke step hard-fails without it (the
    // config's smoke.binaryDefault serves local CLI runs only).
    const binaries = rel.jobs!["binaries"]! as Job & { with?: Record<string, unknown> };
    const targets = JSON.parse(String(binaries.with?.["targets"] ?? "[]")) as Array<{
      key: string;
      runner: string;
      smoke: boolean;
      binary?: string;
    }>;
    expect(targets.length).toBe(4);
    const config = JSON.parse(readFileSync(resolve(ROOT, "toolchain.config.json"), "utf8")) as {
      build: { outDir: string; targets: Array<{ key: string; appArtifact: string }> };
    };
    const appArtifactByKey = new Map(config.build.targets.map((t) => [t.key, t.appArtifact]));
    let smokeLegs = 0;
    for (const target of targets) {
      expect(appArtifactByKey.has(target.key), `matrix key ${target.key} must exist in toolchain.config.json`).toBe(true);
      if (target.smoke) {
        smokeLegs += 1;
        expect(target.binary, `smoke leg ${target.key} must carry binary`).toBeTruthy();
        expect(target.binary).toBe(`${config.build.outDir}/${appArtifactByKey.get(target.key)}`);
      }
    }
    expect(smokeLegs).toBeGreaterThan(0);
  });

  test("gh-release calls the reusable workflow at @main and gates on staged assets", () => {
    const gh = rel.jobs!["gh-release"]!;
    expect(gh.uses).toBe(`${REUSABLE}/reusable-gh-release.yml@main`);
    expect(needsOf(gh)).toContain("stage-release-assets");
  });

  test("publish-npm calls the reusable npm-publish at @main and needs gh-release", () => {
    const pub = rel.jobs!["publish-npm"]!;
    expect(pub.uses).toBe(`${REUSABLE}/reusable-npm-publish.yml@main`);
    expect(needsOf(pub)).toContain("gh-release");
    expect(pub.uses).toBeTruthy();
  });

  test("dispatch is dry-run unless mode=release", () => {
    // A release-mode dispatch is a first-class publish path (the zero-touch
    // auto-release job in ci.yml dispatches release.yml with mode=release), so
    // the publish jobs run on a push OR a release-mode dispatch — while
    // install-smoke's non-release-dispatch legs and the binaries job's
    // dry-validation leg stay fenced off to a non-release dispatch so they can
    // never publish.
    const publishJobs = ["stage-release-assets", "gh-release", "publish-npm"];
    for (const name of publishJobs) {
      const cond = String(rel.jobs![name]!.if);
      expect(cond, `${name}.if must still gate on push`).toContain("github.event_name == 'push'");
      expect(cond, `${name}.if must also allow a release-mode dispatch`).toContain("inputs.mode == 'release'");
    }

    const binariesIf = String(rel.jobs!["binaries"]!.if);
    expect(binariesIf).toContain("github.event_name == 'workflow_dispatch'");
    expect(binariesIf).toContain("inputs.mode != 'release'");
  });

  test("workflow_dispatch exposes a mode input defaulting to dry-run", () => {
    const inputs = (
      rel.on as {
        workflow_dispatch?: { inputs?: Record<string, { default?: string; type?: string; options?: string[] }> };
      }
    ).workflow_dispatch?.inputs ?? {};
    expect(inputs.mode).toBeTruthy();
    expect(inputs.mode?.default).toBe("dry-run");
    expect(inputs.mode?.type).toBe("choice");
    expect(inputs.mode?.options).toEqual(expect.arrayContaining(["dry-run", "release"]));
  });

  test("the tag-push publish path is preserved unchanged (manual redo)", () => {
    // Every release job that gates on a release-mode dispatch must still also
    // gate on a plain push, so pushing a v* tag by hand releases exactly as before.
    for (const name of ["release-verify", "stage-release-assets", "gh-release", "publish-npm"]) {
      expect(String(rel.jobs![name]!.if)).toContain("github.event_name == 'push'");
    }
  });

  test("checkouts that could default to the ref input's \"main\" instead resolve the tag ref in release mode", () => {
    // daemon-smoke checks out `github.event.inputs.ref || github.ref`, which
    // would silently resolve to the ref input's "main" default on a
    // release-mode dispatch (inputs.ref is never set by the auto-release job's
    // dispatch call) unless a release-mode branch takes priority.
    const job = rel.jobs!["daemon-smoke"]!;
    const checkout = steps(job).find((s) => String(s.uses ?? "").startsWith("actions/checkout@"));
    const ref = String((checkout?.with as { ref?: string } | undefined)?.ref ?? "");
    expect(ref, "daemon-smoke checkout ref must special-case a release-mode dispatch").toContain("inputs.mode == 'release'");
  });

  test("artifact-glob and assets-glob inputs are newline-separated multi-line blocks", () => {
    // The reusable workflows expand these globs one-per-line; a space-separated
    // single-line value silently becomes one glob that matches nothing (an
    // adjacent repo shipped exactly that and its shape suite passed over it).
    const globInputs: Array<{ job: string; input: string }> = [
      { job: "binaries", input: "artifact-glob" },
      { job: "gh-release", input: "assets-glob" },
    ];
    for (const { job, input } of globInputs) {
      const def = rel.jobs![job]! as Job & { with?: Record<string, unknown> };
      const value = String(def.with?.[input] ?? "");
      expect(value, `${job}.with.${input} must be set`).not.toBe("");
      const globs = value.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
      expect(globs.length, `${job}.with.${input} must list multiple globs, one per line`).toBeGreaterThan(1);
      for (const glob of globs) {
        expect(glob, `${job}.with.${input} line "${glob}" must not be space-separated`).not.toMatch(/\s/);
      }
    }
  });

  test("this repo has no platform-package or GitHub-Packages-mirror jobs (single npm package)", () => {
    const names = jobs(rel).map(([n]) => n);
    for (const absent of [
      "publish-platform-packages",
      "publish-github-packages",
      "publish-github-platform-packages",
    ]) {
      expect(names).not.toContain(absent);
    }
  });

  test("concurrency never cancels an in-progress release", () => {
    expect(rel.concurrency?.["cancel-in-progress"]).toBe(false);
  });
});

describe("release.yml: publish topology (GH Release before the registry)", () => {
  const rel = load("release.yml");

  test("publish-npm runs AFTER gh-release", () => {
    expect(needsOf(rel.jobs!["publish-npm"]!)).toContain("gh-release");
  });

  test("gh-release runs AFTER the staged assets, which run AFTER the binary matrix + smokes", () => {
    expect(needsOf(rel.jobs!["gh-release"]!)).toContain("stage-release-assets");
    const stageNeeds = needsOf(rel.jobs!["stage-release-assets"]!);
    expect(stageNeeds).toContain("binaries");
    expect(stageNeeds).toContain("install-smoke");
    expect(stageNeeds).toContain("daemon-smoke");
  });
});

describe("composite setup action: single Bun source", () => {
  test("action metadata never references the vars context", () => {
    // GitHub template-evaluates the ENTIRE action manifest — including input
    // descriptions — and the vars context does not exist in composite actions.
    // A literal vars expression anywhere in this file fails every consuming
    // job at load time.
    const raw = readFileSync(resolve(ROOT, ".github/actions/setup/action.yml"), "utf8");
    expect(raw).not.toMatch(/\$\{\{\s*vars\./);
  });

  test("exposes a bun-version input with a default", () => {
    const action = Bun.YAML.parse(readFileSync(resolve(ROOT, ".github/actions/setup/action.yml"), "utf8")) as {
      inputs?: { "bun-version"?: { default?: string } };
    };
    expect(action.inputs?.["bun-version"]?.default).toBeTruthy();
  });
});
