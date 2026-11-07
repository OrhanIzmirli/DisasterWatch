import { useEffect, useRef } from "react";
import SwaggerUI from "swagger-ui-dist/swagger-ui-es-bundle.js";
import "swagger-ui-dist/swagger-ui.css";

/**
 * Swagger UI's own markup misses a few accessibility basics (axe, WCAG 2.2 AA):
 * scrollable code blocks cannot be reached by keyboard and some selects have
 * no accessible name. Patched on every render, since Swagger UI redraws parts
 * of the panel as endpoints open and requests run. Colours are fixed in App.css.
 */
function patchAccessibility(root: HTMLElement) {
  for (const pre of root.querySelectorAll<HTMLElement>("pre:not([tabindex])")) {
    pre.tabIndex = 0; // scrollable region must be focusable
  }
  for (const select of root.querySelectorAll<HTMLSelectElement>("select:not([aria-label])")) {
    const param = select.closest("tr[data-param-name]")?.getAttribute("data-param-name");
    const label = select.id === "servers" ? "Server" : param ? `Value of ${param}` : select.closest(".response-control-media-type") ? "Response media type" : null;
    if (label) select.setAttribute("aria-label", label);
  }
}

/**
 * Swagger UI over the API's OpenAPI document. Imported only by the API page
 * (React.lazy), so the ~0.5 MB bundle and its stylesheet never load elsewhere.
 * Only GET can be tried; requests go to the server named in the document
 * (the same origin by default). When the document cannot be fetched, Swagger
 * UI says so itself; the link below the panel always works.
 */
export default function ApiReference({ specUrl }: { specUrl: string }) {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const node = host.current;
    if (!node) return;
    const observer = new MutationObserver(() => patchAccessibility(node));
    observer.observe(node, { childList: true, subtree: true });
    SwaggerUI({
      domNode: node,
      url: specUrl,
      deepLinking: false,
      docExpansion: "list",
      defaultModelsExpandDepth: 0,
      displayRequestDuration: true,
      supportedSubmitMethods: ["get"],
      // plain JSON: the highlighter's colours fall below 4.5:1 on its dark background
      syntaxHighlight: false,
    });
    return () => {
      observer.disconnect();
      node.innerHTML = "";
    };
  }, [specUrl]);

  return (
    <>
      <div className="api-reference" ref={host} />
      <p className="api-reference-note api-reference-after">
        Raw document: <a href={specUrl}>{specUrl}</a>
      </p>
    </>
  );
}
