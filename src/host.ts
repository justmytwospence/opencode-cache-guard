// Solid and the JSX runtime from opencode itself, for a TUI plugin with no JSX and no static Solid
// imports.
//
// opencode compiles a plugin's .tsx with its Solid transform only outside node_modules, and maps
// `solid-js` and `@opentui/solid` imports to its own copies only in files whose path has no `#`
// or `?`. A git install lives in `node_modules/…/<name>#<commit>/`, so neither applies there: a
// .tsx fails to load (`Cannot find module '@opentui/solid/jsx-dev-runtime'`), and a static
// `solid-js` import would load a second Solid. The host's copies are also Bun virtual modules,
// `opentui:runtime-module:<specifier>`, importable from anywhere; a checkout without them (or an
// opencode that renames them) falls back to the plain specifiers.

const RUNTIME_MODULE = "opentui:runtime-module:";

export type Solid = typeof import("solid-js");
export type JsxRuntime = typeof import("@opentui/solid/jsx-runtime");

async function hostModule<T>(specifier: string, fallback: () => Promise<T>): Promise<T> {
  try {
    return (await import(RUNTIME_MODULE + encodeURIComponent(specifier))) as T;
  } catch {
    return fallback();
  }
}

export async function loadHost(): Promise<{ solid: Solid; jsx: JsxRuntime["jsx"] }> {
  const solid = await hostModule<Solid>("solid-js", () => import("solid-js"));
  const { jsx } = await hostModule<JsxRuntime>("@opentui/solid/jsx-runtime", () => import("@opentui/solid/jsx-runtime"));
  return { solid, jsx };
}

/** A run of text in one line; `color` overrides the line's color. */
export interface Segment<Color = unknown> {
  text: string;
  color?: Color;
}

/**
 * A one-line `<text>` beside the prompt, shown while `segments()` is defined. Reactive: it reads
 * `segments()` and the theme inside Solid's tracking, as JSX would.
 */
export function line<Color>(
  host: { solid: Solid; jsx: JsxRuntime["jsx"] },
  fg: () => Color,
  segments: () => Segment<Color>[] | undefined,
) {
  const { solid, jsx } = host;
  return jsx(solid.Show as never, {
    get when() {
      return segments() !== undefined;
    },
    get children() {
      return jsx("text", {
        get fg() {
          return fg();
        },
        wrapMode: "none",
        children: () =>
          (segments() ?? []).map((s) => (s.color === undefined ? s.text : jsx("span", { style: { fg: s.color }, children: s.text }))),
      });
    },
  });
}
