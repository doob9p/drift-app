/**
 * Resolve a file under Vite `public/` for both `vite` (http) and Electron
 * `loadFile` (file://). Absolute `/foo.png` breaks under file:// because it
 * resolves to the filesystem root.
 */
export function publicAsset(pathFromPublic: string): string {
  const clean = pathFromPublic.replace(/^\/+/, "");
  try {
    return new URL(clean, document.baseURI).href;
  } catch {
    return `./${clean}`;
  }
}
