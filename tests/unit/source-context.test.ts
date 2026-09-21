import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { expect, it } from "vitest";
import { SourceContext } from "../../apps/web/src/components/issues/SourceContext";
import { StackTrace } from "../../apps/web/src/components/issues/StackTrace";
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

it("explains frames without a source file and displays the bounded diagnostics", () => {
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

  expect(html).toContain("No source file");
  expect(html).toContain("cannot be mapped to application source");
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

it("selects the first mapped caller after a browser runtime frame", () => {
  const html = renderToStaticMarkup(
    createElement(StackTrace, {
      frames: [
        {
          filename: "/assets/app.js",
          function: "i",
          lineno: 2,
          colno: 2933,
          in_app: true,
        },
        {
          filename: "/<anonymous>",
          function: "JSON.parse",
          lineno: 0,
          colno: 0,
          in_app: true,
        },
      ],
      originals: [
        {
          filename: "src/settings/SettingsDialog.tsx",
          function: "i",
          lineno: 33,
          colno: 14,
          preContext: ["if (preview) {"],
          contextLine: "JSON.parse('{');",
          postContext: ["}"],
        },
        null,
      ],
    }),
  );

  expect(html).toContain("2 frames · 1 with original locations");
  expect(html).toContain("SettingsDialog.tsx");
  expect(html).toContain("Original location · function i");
  expect(html).toContain("JSON.parse");
  expect(html).toContain("Browser runtime");
  expect(html).toContain("JSON.parse(&#x27;{&#x27;);");
  expect(html).not.toContain("Code entered in the browser console");
});

it("does not call a built-in JavaScript frame a missing source map", () => {
  const html = renderToStaticMarkup(
    createElement(SourceContext, {
      frame: {
        filename: "/<anonymous>",
        function: "JSON.parse",
        lineno: 0,
        colno: 0,
        in_app: true,
      },
    }),
  );

  expect(html).toContain("Browser runtime");
  expect(html).toContain("Select the next mapped frame");
  expect(html).not.toContain("Source map unavailable");
});
