import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceContext } from "../../apps/web/src/components/issues/SourceContext";
import { EventDiagnostics } from "../../apps/web/src/components/issues/EventDiagnostics";

it("renders restored code as text, retaining the compiled location", () => {
  const html = renderToStaticMarkup(
    createElement(SourceContext, {
      frame: {
        filename: "/assets/app.js",
        function: "r",
        lineno: 2,
        colno: 10,
        in_app: true,
      },
      original: {
        filename: "src/app.tsx",
        function: "render",
        lineno: 42,
        colno: 3,
        preContext: ["// before"],
        contextLine: '<script>alert("x")</script>',
        postContext: ["// after"],
      },
    }),
  );

  expect(html).toContain("src/app.tsx");
  expect(html).toContain("Compiled: /assets/app.js:2:10");
  expect(html).toContain("&lt;script&gt;");
  expect(html).not.toContain("<script>");
  expect(html).toContain("source-code-error");
});

it("explains anonymous console frames and displays the bounded diagnostics", () => {
  const html = renderToStaticMarkup(
    createElement(SourceContext, {
      frame: {
        filename: "/<anonymous>",
        function: "?",
        lineno: 2,
        colno: 9,
        in_app: true,
      },
    }),
  );

  expect(html).toContain("Code entered in the browser console");
  const details = renderToStaticMarkup(
    createElement(EventDiagnostics, {
      event: {
        browserName: "Chrome",
        browserMajor: 140,
        apiCode: "error.request",
        apiReason: "timeout",
        httpStatus: 504,
      },
    }),
  );

  expect(details).toContain("Chrome 140");
  expect(details).toContain("error.request");
  expect(details).toContain("timeout");
  expect(details).toContain("504");
});
