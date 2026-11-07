// swagger-ui-dist ships no types; only the options ApiReference.tsx passes are declared.
declare module "swagger-ui-dist/swagger-ui-es-bundle.js" {
  interface SwaggerUIOptions {
    domNode: HTMLElement;
    url: string;
    deepLinking?: boolean;
    docExpansion?: "list" | "full" | "none";
    defaultModelsExpandDepth?: number;
    displayRequestDuration?: boolean;
    supportedSubmitMethods?: string[];
    syntaxHighlight?: false | { activated?: boolean; theme?: string };
  }
  const SwaggerUI: (options: SwaggerUIOptions) => unknown;
  export default SwaggerUI;
}
