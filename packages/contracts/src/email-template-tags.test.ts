// A placeholder the editor split apart (auto-link, bold mid-tag) must still be
// a placeholder to the save check AND the render, or the reader gets braces.
import { describe, expect, it } from "vitest";
import {
  findTemplateVariables,
  isEmailVariableName,
  repairTemplateTags,
  replaceTemplateVariables,
} from "./email.ts";

// The live campaign body that sent "Hi {{recipient.name}}" to a real inbox:
// the editor auto-linked the name (`.name` is a TLD) and bold split the braces.
const EDITOR_SPLIT_BODY =
  '<p>Hi <strong>{{</strong><a target="_blank" rel="noopener noreferrer nofollow" href="http://recipient.name"><strong>recipient.name</strong></a><strong>}}</strong>,</p>';

describe("repairTemplateTags", () => {
  it("pulls an auto-linked, bolded placeholder back together", () => {
    const repaired = repairTemplateTags(EDITOR_SPLIT_BODY);
    expect(repaired).toBe(
      "<p>Hi <strong>{{recipient.name}}</strong><strong></strong><strong></strong>,</p>",
    );
    expect(repaired).not.toContain("http://recipient.name");
  });

  it("is what the check and the substitution both read", () => {
    expect(findTemplateVariables(EDITOR_SPLIT_BODY)).toEqual(["recipient.name"]);
    expect(replaceTemplateVariables(EDITOR_SPLIT_BODY, () => "Alex")).toBe(
      "<p>Hi <strong>Alex</strong><strong></strong><strong></strong>,</p>",
    );
  });

  it("repairs a tag split by formatting alone", () => {
    expect(repairTemplateTags("{{<em>contact</em>.email}}")).toBe("{{contact.email}}<em></em>");
  });

  it("keeps a link that only closes inside the braces", () => {
    expect(repairTemplateTags('<a href="https://x.test">{{site</a>.name}}')).toBe(
      '<a href="https://x.test">{{site.name}}</a>',
    );
  });

  it("leaves anything that is not a bare name untouched", () => {
    const prose = "{{<b>not a name</b>}} and {{plain.tag}}";
    expect(repairTemplateTags(prose)).toBe(prose);
    expect(repairTemplateTags("no braces <b>here</b>")).toBe("no braces <b>here</b>");
  });
});

describe("isEmailVariableName", () => {
  it("knows the global and per-template placeholders", () => {
    expect(isEmailVariableName("recipient.name")).toBe(true);
    expect(isEmailVariableName("unsubscribe.url")).toBe(true);
    expect(isEmailVariableName("example.com")).toBe(false);
    expect(isEmailVariableName("https://recipient.name")).toBe(false);
  });
});
