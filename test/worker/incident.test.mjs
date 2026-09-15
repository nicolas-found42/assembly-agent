// test/worker/incident.test.mjs — decision logic of scripts/incident.mjs, driven by fixtures.
//
// scripts/incident.mjs keeps the dedup/recovery decisions in pure functions (identityFor, planIncident,
// parseIssueBody, decideRun, sanitizeUntrusted); this suite exercises those against fixture inputs, in
// the same workerd run as the Worker tests, and never performs a network call or creates an issue.
import { describe, expect, test } from "vitest";
import {
  SANITIZE_LIMIT,
  decideRun,
  identityFor,
  parseIssueBody,
  planIncident,
  sanitizeUntrusted,
} from "../../scripts/incident.mjs";
import fixtures from "./fixtures/incidents.json";

const eventOf = (name) => {
  const raw = fixtures.events[name];
  return { ...raw, identity: identityFor({ service: raw.service, failureClass: raw.failureClass }) };
};
const parsedOf = (name) => parseIssueBody(fixtures.issues[name].body);

describe("fixture sanity", () => {
  test("issue fixtures parse back to the identity they were written for", () => {
    expect(parsedOf("openDeploymentTwiceSeen")).toEqual({
      id: "live-health:deployment",
      service: "live-health",
      failureClass: "deployment",
      occurrences: 2,
      severity: "high",
      firstSeen: "2026-09-15T02:00:00.000Z",
      lastSeen: "2026-09-15T03:00:00.000Z",
    });
    expect(parsedOf("unrelated")).toBeNull();
  });
});

describe("dedup on repeat failure", () => {
  test("a first failure with no open incident plans a create carrying the identity marker", () => {
    const plan = planIncident(eventOf("firstFailure"), null);

    expect(plan.action).toBe("create");
    expect(plan.issue.labels).toEqual(["ci-incident"]);
    expect(plan.issue.title).toBe("[ci-incident][high] live-health — deployment failure");
    expect(plan.issue.body).toContain("service=live-health class=deployment occurrences=1");
    expect(plan.issue.body).toContain("`site.build-info-missing`");
    // The same body must round-trip back to the same identity.
    expect(parseIssueBody(plan.issue.body).id).toBe("live-health:deployment");
  });

  test("a repeat failure on the open incident plans a repeat, not a second issue", () => {
    const existing = parsedOf("openDeploymentTwiceSeen");
    const plan = planIncident(eventOf("repeatFailure"), existing);

    expect(plan.action).toBe("repeat");
    expect(plan.issue).toBeUndefined(); // no new issue
    expect(plan.occurrences).toBe(3);
    expect(plan.comment).toContain("Repeat #3");
    expect(parseIssueBody(plan.issueUpdate.body)).toMatchObject({ id: "live-health:deployment", occurrences: 3 });
    // first seeen is preserved across repeats; last seen moves to this run.
    expect(parseIssueBody(plan.issueUpdate.body).firstSeen).toBe("2026-09-15T02:00:00.000Z");
    expect(parseIssueBody(plan.issueUpdate.body).lastSeen).toBe("2026-09-15T03:00:00.000Z");
  });

  test("a different failure class is a different identity: it opens its own incident", () => {
    const plan = planIncident(eventOf("hostileFailure"), parsedOf("openDeploymentTwiceSeen"));
    expect(plan.action).toBe("create");
    expect(plan.issue.title).toContain("infrastructure");
  });

  test("a covered event with no optional fields still produces a complete issue", () => {
    const plan = planIncident(eventOf("emptyDetails"), null);
    expect(plan.action).toBe("create");
    expect(plan.issue.body).not.toContain("undefined");
    expect(parseIssueBody(plan.issue.body).id).toBe("live-health:budget");
  });
});

describe("recovery", () => {
  test("a passing run on an open incident records a recovery and closes it", () => {
    const plan = planIncident(eventOf("recovery"), parsedOf("openDeploymentTwiceSeen"));

    expect(plan.action).toBe("recover");
    expect(plan.comment).toContain("Recovered");
    expect(plan.issueUpdate.state).toBe("closed");
    expect(plan.issueUpdate.state_reason).toBe("completed");
    expect(plan.issueUpdate.body).toContain("occurrences=2");
    expect(plan.issueUpdate.body).toContain("recovered at: 2026-09-15T04:00:00.000Z");
  });

  test("a recovery with no open incident is a no-op", () => {
    const plan = planIncident(eventOf("recovery"), null);
    expect(plan.action).toBe("noop");
    expect(plan.reason).toContain("nothing to recover");
  });
});

describe("untrusted text is data", () => {
  test("workflow commands, comment markers, newlines and backticks are neutralised", () => {
    const plan = planIncident(eventOf("hostileFailure"), null);

    expect(plan.issue.body).not.toContain("::error::");
    expect(plan.issue.body).not.toContain("::warning::");
    expect(plan.issue.body).not.toContain("```");
    // Only the real marker exists; the forged one in the detail cannot be parsed as a second identity.
    expect(plan.issue.body.match(/<!--/g)).toHaveLength(1);
    expect(parseIssueBody(plan.issue.body).id).toBe("live-health:infrastructure");
    // The reported content is preserved as data, collapsed onto one quoted line.
    const quoted = plan.issue.body.split("\n").filter((line) => line.startsWith("> "));
    expect(quoted).toHaveLength(1);
    expect(quoted[0]).toContain("deployment broken");
    expect(quoted[0]).not.toContain("<!--");
    expect(quoted[0]).not.toContain("`");
  });

  test("sanitizeUntrusted bounds the length and strips control characters", () => {
    const dirty = `\u0000start\r\n${"x".repeat(1000)}\u001b[31m`;
    const clean = sanitizeUntrusted(dirty);
    expect(clean.length).toBeLessThanOrEqual(SANITIZE_LIMIT);
    expect(clean).not.toMatch(/[\u0000-\u001f\u007f]/);
  });

  test("the identity is slugged, so a crafted service name cannot forge another identity", () => {
    expect(identityFor({ service: "live health<!-- x -->", failureClass: "Café Failure" })).toEqual({
      id: "live-health-x:caf-failure",
      service: "live-health-x",
      failureClass: "caf-failure",
    });
  });
});

describe("reporting gate", () => {
  const base = { enabled: true, dryRun: false, token: "t", repo: "o/r", permission: true };

  test.each([
    ["disabled", { ...base, enabled: false }, "not-enabled"],
    ["dry run", { ...base, dryRun: true }, "dry-run"],
    ["no token", { ...base, token: "" }, "no-token"],
    ["no repository", { ...base, repo: "" }, "no-repo"],
    ["no push permission", { ...base, permission: false }, "no-permission"],
    ["permission unknown", { ...base, permission: undefined }, "probing-permission"],
    ["permitted", base, "reporting"],
  ])("%s → %s", (_label, input, expected) => {
    const decision = decideRun(input);
    expect(decision.outcome).toBe(expected);
    expect(decision.reason).toBeTruthy();
    expect(decision.proceed).toBe(expected === "reporting" || expected === "probing-permission");
  });
});
