import type { IconNode } from "lucide";
import {
  ArrowUp,
  Bot,
  Check,
  ChevronDown,
  ChevronRight,
  Cpu,
  File,
  Folder,
  FolderInput,
  FolderOpen,
  HardDrive,
  List,
  LoaderCircle,
  MemoryStick,
  MessageCircle,
  Monitor,
  PanelLeft,
  PanelRight,
  RefreshCw,
  RotateCcw,
  Search,
  Server,
  Settings,
  Sparkles,
  Square,
  Terminal,
  Trash2,
} from "lucide";

type IconOpts = {
  size?: number;
  strokeWidth?: number;
  className?: string;
};

function attrsToString(attrs: Record<string, string | number | undefined>): string {
  return Object.entries(attrs)
    .filter(([, value]) => value !== undefined)
    .map(([key, value]) => {
      const name = key.replace(/([A-Z])/g, "-$1").toLowerCase();
      return `${name}="${String(value).replaceAll('"', "&quot;")}"`;
    })
    .join(" ");
}

/** Render a Lucide icon node as an inline SVG string. */
export function lucideSvg(node: IconNode, opts: IconOpts = {}): string {
  const size = opts.size ?? 16;
  const strokeWidth = opts.strokeWidth ?? 1.75;
  const classAttr = opts.className ? ` class="${opts.className}"` : "";
  const body = node
    .map(([tag, attrs]) => `<${tag} ${attrsToString(attrs)} />`)
    .join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round"${classAttr} aria-hidden="true">${body}</svg>`;
}

export const icons = {
  settings: (size = 16) => lucideSvg(Settings, { size }),
  terminal: (size = 14) => lucideSvg(Terminal, { size }),
  chevronDown: (size = 12) => lucideSvg(ChevronDown, { size, strokeWidth: 2 }),
  search: (size = 14) => lucideSvg(Search, { size }),
  refresh: (size = 14) => lucideSvg(RefreshCw, { size }),
  check: (size = 12) => lucideSvg(Check, { size, strokeWidth: 2.25 }),
  trash: (size = 14) => lucideSvg(Trash2, { size }),
  monitor: (size = 14) => lucideSvg(Monitor, { size }),
  server: (size = 16) => lucideSvg(Server, { size }),
  folder: (size = 14) => lucideSvg(Folder, { size }),
  folderOpen: (size = 14) => lucideSvg(FolderOpen, { size }),
  importConfig: (size = 14) => lucideSvg(FolderInput, { size }),
  file: (size = 14) => lucideSvg(File, { size }),
  chevronRight: (size = 12) => lucideSvg(ChevronRight, { size, strokeWidth: 2 }),
  sparkles: (size = 14) => lucideSvg(Sparkles, { size }),
  bot: (size = 14) => lucideSvg(Bot, { size }),
  list: (size = 14) => lucideSvg(List, { size }),
  message: (size = 14) => lucideSvg(MessageCircle, { size }),
  brand: (size = 16) => lucideSvg(Terminal, { size, strokeWidth: 2 }),
  send: (size = 16) => lucideSvg(ArrowUp, { size, strokeWidth: 2.25 }),
  loading: (size = 16) => lucideSvg(LoaderCircle, { size, strokeWidth: 2 }),
  cpu: (size = 13) => lucideSvg(Cpu, { size }),
  memory: (size = 13) => lucideSvg(MemoryStick, { size }),
  disk: (size = 13) => lucideSvg(HardDrive, { size }),
  stop: (size = 12) => lucideSvg(Square, { size, strokeWidth: 2.25 }),
  restartChat: (size = 16) => lucideSvg(RotateCcw, { size }),
  panelLeft: (size = 16) => lucideSvg(PanelLeft, { size }),
  panelRight: (size = 16) => lucideSvg(PanelRight, { size }),
};
