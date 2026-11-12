import { basicSetup } from "codemirror";
import { EditorState, Compartment, Prec, type Extension } from "@codemirror/state";
import {
  EditorView,
  keymap,
  placeholder as cmPlaceholder,
  runScopeHandlers,
  type Panel,
} from "@codemirror/view";
import {
  indentLess,
  indentMore,
  indentWithTab,
  toggleComment,
} from "@codemirror/commands";
import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  openSearchPanel,
  search,
  SearchQuery,
  setSearchQuery,
} from "@codemirror/search";
import { oneDark } from "@codemirror/theme-one-dark";
import { LanguageDescription } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { icons } from "./icons.js";
import { t } from "./i18n.js";
import { showToast } from "./toast.js";

export type EditorScope = "local" | "remote";

export type EditorDoc = {
  id: string;
  scope: EditorScope;
  tabId?: string;
  path: string;
  name: string;
  kind: "text" | "image";
  content: string;
  original: string;
  dataUrl?: string;
  mime?: string;
  dirty: boolean;
  readonly?: boolean;
};

type ReadResult =
  | { path: string; kind: "text"; content: string }
  | { path: string; kind: "image"; mime: string; dataUrl: string }
  | { path: string; content: string }
  | { error: string };
type WriteResult = { ok: true; path: string } | { error: string };

function basename(p: string): string {
  const parts = p.replace(/\\/g, "/").split("/");
  return parts[parts.length - 1] || p;
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const languageCache = new Map<string, Extension>();

async function languageForPath(filePath: string): Promise<Extension> {
  const name = basename(filePath);
  const cached = languageCache.get(name);
  if (cached) return cached;
  const desc = LanguageDescription.matchFilename(languages, name);
  if (!desc) {
    languageCache.set(name, []);
    return [];
  }
  try {
    const support = await desc.load();
    languageCache.set(name, support);
    return support;
  } catch {
    languageCache.set(name, []);
    return [];
  }
}

const driftEditorTheme = EditorView.theme(
  {
    "&": {
      height: "100%",
      fontSize: "13px",
      backgroundColor: "var(--term)",
    },
    ".cm-scroller": {
      fontFamily: "var(--mono)",
      lineHeight: "1.55",
      overflow: "auto",
    },
    ".cm-content": {
      caretColor: "var(--text)",
      paddingTop: "8px",
      paddingBottom: "24px",
    },
    ".cm-cursor, .cm-dropCursor": {
      borderLeftColor: "var(--accent)",
    },
    "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
      {
        backgroundColor: "rgba(79, 143, 202, 0.35)",
      },
    ".cm-activeLine": {
      backgroundColor: "rgba(255, 255, 255, 0.035)",
    },
    ".cm-gutters": {
      backgroundColor: "var(--term)",
      color: "var(--text-3)",
      border: "none",
      borderRight: "1px solid var(--line)",
      minWidth: "44px",
    },
    ".cm-lineNumbers .cm-gutterElement": {
      padding: "0 10px 0 8px",
      minWidth: "2.4em",
    },
    ".cm-activeLineGutter": {
      backgroundColor: "rgba(255, 255, 255, 0.04)",
      color: "var(--text-2)",
    },
    ".cm-foldPlaceholder": {
      backgroundColor: "var(--elevated)",
      border: "none",
      color: "var(--text-2)",
    },
    ".cm-tooltip": {
      backgroundColor: "var(--elevated)",
      border: "1px solid var(--line-strong)",
      color: "var(--text)",
    },
    ".cm-panels": {
      backgroundColor: "transparent",
      color: "var(--text)",
      border: "none",
    },
    ".cm-panels.cm-panels-top": {
      border: "none",
    },
    ".cm-searchMatch": {
      backgroundColor: "rgba(212, 163, 90, 0.35)",
    },
    ".cm-searchMatch.cm-searchMatch-selected": {
      backgroundColor: "rgba(79, 143, 202, 0.55)",
    },
    ".cm-matchingBracket, .cm-nonmatchingBracket": {
      backgroundColor: "rgba(79, 143, 202, 0.22)",
      outline: "1px solid rgba(79, 143, 202, 0.45)",
    },
  },
  { dark: true }
);

function createSimpleSearchPanel(view: EditorView): Panel {
  const dom = document.createElement("div");
  dom.className = "cm-simple-find";
  dom.innerHTML = `
    <span class="cm-simple-find-ico" aria-hidden="true">${icons.search(14)}</span>
    <input class="cm-simple-find-input" type="text" placeholder="${t("editor.find")}" main-field="true" autocomplete="off" spellcheck="false" />
    <div class="cm-simple-find-actions">
      <button type="button" class="cm-simple-find-btn" data-find="prev" title="${t("editor.findPrev")}" aria-label="${t("editor.findPrev")}">${icons.chevronUp(14)}</button>
      <button type="button" class="cm-simple-find-btn" data-find="next" title="${t("editor.findNext")}" aria-label="${t("editor.findNext")}">${icons.chevronDown(14)}</button>
      <button type="button" class="cm-simple-find-btn" data-find="close" title="${t("editor.findClose")}" aria-label="${t("editor.findClose")}">${icons.close(14)}</button>
    </div>
  `;
  const input = dom.querySelector(".cm-simple-find-input") as HTMLInputElement;
  let query = getSearchQuery(view.state);

  function commitQuery(): void {
    const next = new SearchQuery({
      search: input.value,
      caseSensitive: false,
      literal: true,
    });
    if (next.eq(query)) return;
    query = next;
    // Only update highlights — do not findNext here (it steals input focus).
    view.dispatch({ effects: setSearchQuery.of(next) });
  }

  input.value = query.search;
  input.addEventListener("input", () => commitQuery());

  dom.addEventListener("keydown", (e) => {
    if (runScopeHandlers(view, e, "search-panel")) {
      e.preventDefault();
      return;
    }
    if (e.key === "Enter" && e.target === input) {
      e.preventDefault();
      commitQuery();
      if (e.shiftKey) findPrevious(view);
      else findNext(view);
      // Keep typing focus in the find field.
      requestAnimationFrame(() => input.focus());
    }
  });

  dom.addEventListener("mousedown", (e) => {
    // Keep editor from taking focus when clicking find chrome.
    if (e.target !== input) e.preventDefault();
  });

  dom.addEventListener("click", (e) => {
    const btn = (e.target as HTMLElement).closest(
      "[data-find]"
    ) as HTMLElement | null;
    const action = btn?.dataset.find;
    if (!action) return;
    e.preventDefault();
    if (action === "prev") {
      findPrevious(view);
      input.focus();
    } else if (action === "next") {
      findNext(view);
      input.focus();
    } else if (action === "close") {
      closeSearchPanel(view);
      view.focus();
    }
  });

  return {
    dom,
    top: true,
    mount() {
      input.focus();
      input.select();
    },
    update(update) {
      for (const tr of update.transactions) {
        for (const effect of tr.effects) {
          if (effect.is(setSearchQuery) && !effect.value.eq(query)) {
            query = effect.value;
            if (document.activeElement !== input) {
              input.value = query.search;
            }
          }
        }
      }
    },
  };
}

let docSeq = 0;

export function createEditorPane(opts: {
  root: HTMLElement;
  readLocal: (path: string) => Promise<ReadResult>;
  writeLocal: (path: string, content: string) => Promise<WriteResult>;
  readRemote: (tabId: string, path: string) => Promise<ReadResult>;
  writeRemote: (
    tabId: string,
    path: string,
    content: string
  ) => Promise<WriteResult>;
  onVisibilityChange?: (open: boolean) => void;
}): {
  openLocal: (path: string) => Promise<void>;
  openRemote: (tabId: string, path: string) => Promise<void>;
  isOpen: () => boolean;
  isFocused: () => boolean;
  closeActive: () => Promise<boolean>;
  saveActive: () => Promise<boolean>;
  find: () => boolean;
} {
  const root = opts.root;
  root.innerHTML = `
    <div class="editor-tabs" id="editor-tabs"></div>
    <div class="editor-toolbar">
      <div class="editor-path" id="editor-path"></div>
      <div class="editor-actions">
        <button type="button" class="ghost" id="btn-editor-save" title="Save">${icons.save(14)}<span data-i18n="editor.save">${t("editor.save")}</span></button>
        <button type="button" class="ghost" id="btn-editor-close" title="Close">${icons.close(14)}</button>
      </div>
    </div>
    <div class="editor-body" id="editor-body"></div>
    <div class="editor-image hidden" id="editor-image">
      <img id="editor-image-el" alt="" />
    </div>
    <div class="editor-status" id="editor-status"></div>
  `;

  const tabsEl = root.querySelector("#editor-tabs") as HTMLElement;
  const pathEl = root.querySelector("#editor-path") as HTMLElement;
  const bodyEl = root.querySelector("#editor-body") as HTMLElement;
  const imageWrap = root.querySelector("#editor-image") as HTMLElement;
  const imageEl = root.querySelector("#editor-image-el") as HTMLImageElement;
  const statusEl = root.querySelector("#editor-status") as HTMLElement;
  const saveBtn = root.querySelector("#btn-editor-save") as HTMLButtonElement;
  const closeBtn = root.querySelector("#btn-editor-close") as HTMLButtonElement;

  const docs: EditorDoc[] = [];
  let activeId: string | null = null;
  let applyingDoc = false;
  let langLoadToken = 0;

  const languageCompartment = new Compartment();
  const readOnlyCompartment = new Compartment();

  function activeDoc(): EditorDoc | null {
    return docs.find((d) => d.id === activeId) ?? null;
  }

  function setOpen(open: boolean): void {
    root.classList.toggle("hidden", !open);
    opts.onVisibilityChange?.(open);
  }

  function mapError(code: string): string {
    if (code === "binary") return t("editor.binary");
    if (code === "too_large") return t("editor.tooLarge");
    return code || t("editor.loadFail");
  }

  function cursorLabel(): string {
    const head = view.state.selection.main.head;
    const line = view.state.doc.lineAt(head);
    const col = head - line.from + 1;
    return t("editor.cursor", {
      line: String(line.number),
      col: String(col),
    });
  }

  function showMode(mode: "text" | "image" | "none"): void {
    bodyEl.classList.toggle("hidden", mode !== "text");
    imageWrap.classList.toggle("hidden", mode !== "image");
    saveBtn.classList.toggle("hidden", mode === "image");
  }

  function syncChrome(): void {
    const doc = activeDoc();
    if (!doc) {
      pathEl.textContent = "";
      pathEl.title = "";
      statusEl.textContent = "";
      statusEl.classList.remove("dirty");
      saveBtn.disabled = true;
      showMode("none");
      return;
    }
    pathEl.textContent = doc.path;
    pathEl.title = doc.path;
    if (doc.kind === "image") {
      saveBtn.disabled = true;
      const w = imageEl.naturalWidth || 0;
      const h = imageEl.naturalHeight || 0;
      const sizeLabel =
        w > 0 && h > 0
          ? t("editor.imageSize", { width: String(w), height: String(h) })
          : t("editor.imagePreview");
      statusEl.textContent = sizeLabel;
      statusEl.classList.remove("dirty");
      return;
    }
    saveBtn.disabled = !doc.dirty || !!doc.readonly;
    const stateLabel = doc.dirty ? t("editor.dirty") : t("editor.saved");
    statusEl.textContent = `${stateLabel}  ·  ${cursorLabel()}`;
    statusEl.classList.toggle("dirty", doc.dirty);
  }

  function renderTabs(): void {
    tabsEl.innerHTML = docs
      .map((d) => {
        const active = d.id === activeId ? " active" : "";
        const dirty = d.dirty ? " dirty" : "";
        return `<button type="button" class="editor-tab${active}${dirty}" data-id="${escapeHtml(d.id)}" title="${escapeHtml(d.path)}"><span class="editor-tab-name">${escapeHtml(d.name)}${d.dirty ? " •" : ""}</span><span class="editor-tab-close" data-close="${escapeHtml(d.id)}" aria-label="Close">${icons.close(12)}</span></button>`;
      })
      .join("");
  }

  function persistActiveFromView(): void {
    const doc = activeDoc();
    if (!doc || applyingDoc || doc.kind !== "text") return;
    doc.content = view.state.doc.toString();
    doc.dirty = doc.content !== doc.original;
  }

  async function applyLanguage(path: string): Promise<void> {
    const token = ++langLoadToken;
    const lang = await languageForPath(path);
    if (token !== langLoadToken) return;
    view.dispatch({
      effects: languageCompartment.reconfigure(lang),
    });
  }

  async function loadDocIntoView(doc: EditorDoc | null): Promise<void> {
    applyingDoc = true;
    try {
      if (!doc) {
        imageEl.removeAttribute("src");
        showMode("none");
        view.dispatch({
          changes: {
            from: 0,
            to: view.state.doc.length,
            insert: "",
          },
          effects: [
            languageCompartment.reconfigure([]),
            readOnlyCompartment.reconfigure(EditorState.readOnly.of(true)),
          ],
        });
        return;
      }
      if (doc.kind === "image") {
        showMode("image");
        imageEl.alt = doc.name;
        imageEl.onload = () => syncChrome();
        imageEl.onerror = () => {
          statusEl.textContent = t("editor.imageFail");
        };
        imageEl.src = doc.dataUrl || "";
        return;
      }
      showMode("text");
      imageEl.removeAttribute("src");
      view.dispatch({
        changes: {
          from: 0,
          to: view.state.doc.length,
          insert: doc.content,
        },
        selection: { anchor: 0 },
        effects: [
          readOnlyCompartment.reconfigure(
            EditorState.readOnly.of(!!doc.readonly)
          ),
        ],
      });
      await applyLanguage(doc.path);
      view.focus();
    } finally {
      applyingDoc = false;
    }
  }

  async function renderActive(): Promise<void> {
    const doc = activeDoc();
    if (!doc) {
      await loadDocIntoView(null);
      syncChrome();
      renderTabs();
      setOpen(false);
      return;
    }
    setOpen(true);
    await loadDocIntoView(doc);
    syncChrome();
    renderTabs();
  }

  async function activate(id: string): Promise<void> {
    if (activeId && activeId !== id) persistActiveFromView();
    activeId = id;
    await renderActive();
  }

  async function closeDoc(id: string): Promise<void> {
    if (activeId === id) persistActiveFromView();
    const idx = docs.findIndex((d) => d.id === id);
    if (idx < 0) return;
    const doc = docs[idx]!;
    if (doc.dirty) {
      const ok = window.confirm(`${doc.name}\n\n${t("editor.dirty")}`);
      if (!ok) return;
    }
    docs.splice(idx, 1);
    if (activeId === id) {
      activeId = docs[idx]?.id ?? docs[idx - 1]?.id ?? null;
    }
    await renderActive();
  }

  async function saveActive(): Promise<boolean> {
    const doc = activeDoc();
    if (!doc || doc.readonly || doc.kind !== "text") return false;
    persistActiveFromView();
    if (!doc.dirty) return true;
    const content = doc.content;
    const result =
      doc.scope === "local"
        ? await opts.writeLocal(doc.path, content)
        : await opts.writeRemote(doc.tabId!, doc.path, content);
    if ("error" in result) {
      showToast(mapError(result.error) || t("editor.saveFail"), "error");
      return false;
    }
    doc.content = content;
    doc.original = content;
    doc.dirty = false;
    syncChrome();
    renderTabs();
    showToast(t("editor.saved"), "ok");
    return true;
  }

  function openFind(): boolean {
    if (!activeDoc() || activeDoc()?.kind !== "text") return false;
    if (!view.hasFocus) view.focus();
    return openSearchPanel(view);
  }

  async function openDoc(input: {
    scope: EditorScope;
    tabId?: string;
    path: string;
  }): Promise<void> {
    if (activeId) persistActiveFromView();
    const existing = docs.find(
      (d) =>
        d.path === input.path &&
        d.scope === input.scope &&
        d.tabId === input.tabId
    );
    if (existing) {
      await activate(existing.id);
      return;
    }
    const result =
      input.scope === "local"
        ? await opts.readLocal(input.path)
        : await opts.readRemote(input.tabId!, input.path);
    if ("error" in result) {
      showToast(mapError(result.error), "error");
      return;
    }
    const filePath = result.path || input.path;
    const isImage = "kind" in result && result.kind === "image";
    const doc: EditorDoc = isImage
      ? {
          id: `ed-${++docSeq}`,
          scope: input.scope,
          tabId: input.tabId,
          path: filePath,
          name: basename(filePath),
          kind: "image",
          content: "",
          original: "",
          dataUrl: result.dataUrl,
          mime: result.mime,
          dirty: false,
          readonly: true,
        }
      : {
          id: `ed-${++docSeq}`,
          scope: input.scope,
          tabId: input.tabId,
          path: filePath,
          name: basename(filePath),
          kind: "text",
          content: "content" in result ? result.content : "",
          original: "content" in result ? result.content : "",
          dirty: false,
        };
    docs.push(doc);
    await activate(doc.id);
  }

  const view = new EditorView({
    parent: bodyEl,
    state: EditorState.create({
      doc: "",
      extensions: [
        basicSetup,
        oneDark,
        driftEditorTheme,
        search({
          top: true,
          createPanel: createSimpleSearchPanel,
        }),
        languageCompartment.of([]),
        readOnlyCompartment.of(EditorState.readOnly.of(true)),
        Prec.highest(
          keymap.of([
            indentWithTab,
            {
              key: "Mod-s",
              run: () => {
                void saveActive();
                return true;
              },
            },
            {
              key: "Mod-f",
              run: () => openFind(),
            },
            {
              key: "Mod-/",
              run: toggleComment,
            },
            {
              key: "Mod-]",
              run: indentMore,
            },
            {
              key: "Mod-[",
              run: indentLess,
            },
            {
              key: "Mod-w",
              run: () => {
                const doc = activeDoc();
                if (doc) void closeDoc(doc.id);
                return true;
              },
            },
          ])
        ),
        cmPlaceholder(t("editor.placeholder")),
        EditorView.updateListener.of((update) => {
          const doc = activeDoc();
          if (!doc || doc.kind !== "text") return;
          if (update.docChanged && !applyingDoc) {
            doc.content = update.state.doc.toString();
            doc.dirty = doc.content !== doc.original;
            renderTabs();
            syncChrome();
          } else if (update.selectionSet) {
            syncChrome();
          }
        }),
        EditorView.lineWrapping,
      ],
    }),
  });

  saveBtn.onclick = () => void saveActive();
  closeBtn.onclick = () => {
    const doc = activeDoc();
    if (doc) void closeDoc(doc.id);
  };

  tabsEl.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;
    const close = target.closest("[data-close]") as HTMLElement | null;
    if (close?.dataset.close) {
      e.preventDefault();
      e.stopPropagation();
      void closeDoc(close.dataset.close);
      return;
    }
    const tab = target.closest(".editor-tab") as HTMLElement | null;
    if (tab?.dataset.id) void activate(tab.dataset.id);
  });

  setOpen(false);

  return {
    openLocal: (path) => openDoc({ scope: "local", path }),
    openRemote: (tabId, path) => openDoc({ scope: "remote", tabId, path }),
    isOpen: () => !root.classList.contains("hidden") && docs.length > 0,
    isFocused: () => {
      if (root.classList.contains("hidden") || docs.length === 0) return false;
      if (view.hasFocus) return true;
      const active = document.activeElement;
      return !!active && root.contains(active);
    },
    closeActive: async () => {
      const doc = activeDoc();
      if (!doc) return false;
      await closeDoc(doc.id);
      return true;
    },
    saveActive: () => saveActive(),
    find: () => openFind(),
  };
}
