import { renderToStaticMarkup } from "react-dom/server";

import { renderRichText } from "../components/Comments/richText";

const html = (text: string) =>
  renderToStaticMarkup(<div>{renderRichText(text)}</div>);

describe("comment rich text", () => {
  it("renders inline marks", () => {
    expect(html("a `code` b")).toContain("<code>code</code>");
    expect(html("a **bold** b")).toContain("<strong>bold</strong>");
    expect(html("a ==hi== b")).toContain("<mark>hi</mark>");
    expect(html("a ~~gone~~ b")).toContain("<del>gone</del>");
    expect(html("a *it* b")).toContain("<em>it</em>");
  });

  it("prefers bold over italic at the same position", () => {
    expect(html("**x**")).toContain("<strong>x</strong>");
  });

  it("does not parse markup inside a code span", () => {
    expect(html("`**not bold**`")).toContain("<code>**not bold**</code>");
  });

  it("draws a swatch for a bare hex colour in a code span", () => {
    const out = html("fill is `#b2f2bb`");
    expect(out).toContain("comment-swatch-chip");
    expect(out).toContain("#b2f2bb");
  });

  it("builds bullet and numbered lists", () => {
    expect(html("- one\n- two")).toContain("<ul><li>one</li><li>two</li></ul>");
    expect(html("1. one\n2. two")).toContain(
      "<ol><li>one</li><li>two</li></ol>",
    );
  });

  it("keeps unmatched syntax as literal text", () => {
    const out = html("2 * 3 = 6 and `unclosed");
    expect(out).not.toContain("<em>");
    expect(out).not.toContain("<code>");
    expect(out).toContain("2 * 3 = 6");
  });

  it("escapes rather than executes embedded html", () => {
    const out = html("<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
});
