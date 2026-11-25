import type { IconNode } from "lucide";
import {
  ArrowUp,
  Bot,
  Check,
  Copy,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Cpu,
  Download,
  Eye,
  EyeOff,
  File,
  Folder,
  FolderOpen,
  FolderPlus,
  FolderUp,
  FoldVertical,
  HardDrive,
  Import,
  List,
  LoaderCircle,
  MemoryStick,
  MessageCircle,
  Mic,
  Monitor,
  PanelLeft,
  PanelRight,
  Pause,
  Pencil,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings,
  Sparkles,
  Square,
  Terminal,
  Trash2,
  X,
  ZoomIn,
  ZoomOut,
  Maximize2,
  Plus,
  BotMessageSquare,
  Grid2x2,
  GitBranch,
  Expand,
  LayoutGrid,
  Lock,
  LockOpen,
  Megaphone,
  Paperclip,
  Radio,
  Ellipsis,
  AppWindow,
  Workflow,
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
  chevronUp: (size = 12) => lucideSvg(ChevronUp, { size, strokeWidth: 2 }),
  search: (size = 14) => lucideSvg(Search, { size }),
  refresh: (size = 14) => lucideSvg(RefreshCw, { size }),
  eye: (size = 14) => lucideSvg(Eye, { size }),
  eyeOff: (size = 14) => lucideSvg(EyeOff, { size }),
  check: (size = 12) => lucideSvg(Check, { size, strokeWidth: 2.25 }),
  trash: (size = 14) => lucideSvg(Trash2, { size }),
  pencil: (size = 14) => lucideSvg(Pencil, { size }),
  monitor: (size = 14) => lucideSvg(Monitor, { size }),
  server: (size = 16) => lucideSvg(Server, { size }),
  folder: (size = 14) => lucideSvg(Folder, { size }),
  folderOpen: (size = 14) => lucideSvg(FolderOpen, { size }),
  folderPlus: (size = 14) => lucideSvg(FolderPlus, { size }),
  folderUp: (size = 14) => lucideSvg(FolderUp, { size }),
  /** Collapse all open folder groups (Cursor explorer–style). */
  foldVertical: (size = 14) => lucideSvg(FoldVertical, { size }),
  back: (size = 14) => lucideSvg(ChevronLeft, { size, strokeWidth: 2.25 }),
  importConfig: (size = 14) => lucideSvg(Import, { size }),
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
  stop: (size = 16) =>
    `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="5" width="14" height="14" rx="2.5" fill="currentColor"/></svg>`,
  restartChat: (size = 16) => lucideSvg(RotateCcw, { size }),
  panelLeft: (size = 16) => lucideSvg(PanelLeft, { size }),
  panelRight: (size = 16) => lucideSvg(PanelRight, { size }),
  save: (size = 14) => lucideSvg(Save, { size }),
  close: (size = 14) => lucideSvg(X, { size, strokeWidth: 2 }),
  copy: (size = 14) => lucideSvg(Copy, { size }),
  mic: (size = 14) => lucideSvg(Mic, { size }),
  pause: (size = 14) => lucideSvg(Pause, { size }),
  play: (size = 14) => lucideSvg(Play, { size }),
  stopRec: (size = 14) => lucideSvg(Square, { size, strokeWidth: 2.25 }),
  export: (size = 14) => lucideSvg(Download, { size }),
  zoomIn: (size = 14) => lucideSvg(ZoomIn, { size }),
  zoomOut: (size = 14) => lucideSvg(ZoomOut, { size }),
  zoomFit: (size = 14) => lucideSvg(Maximize2, { size }),
  plus: (size = 14) => lucideSvg(Plus, { size }),
  /** Open / attach an AI prompt card. */
  addPrompt: (size = 14) => lucideSvg(BotMessageSquare, { size }),
  /** Tidy cards by session (terminal + linked prompts). */
  arrange: (size = 14) => lucideSvg(Grid2x2, { size }),
  /** Pack open terminals edge-to-edge in the viewport. */
  tileFill: (size = 14) => lucideSvg(Expand, { size }),
  /** Fit open terminals on screen with small gaps. */
  tileFit: (size = 14) => lucideSvg(LayoutGrid, { size }),
  lockView: (size = 14) => lucideSvg(Lock, { size }),
  unlockView: (size = 14) => lucideSvg(LockOpen, { size }),
  /** Broadcast keystrokes to linked terminals. */
  broadcast: (size = 14) => lucideSvg(Megaphone, { size }),
  /** Per-card broadcast membership chip. */
  broadcastMember: (size = 12) => lucideSvg(Radio, { size, strokeWidth: 2 }),
  addSub: (size = 14) => lucideSvg(GitBranch, { size }),
  attach: (size = 14) => lucideSvg(Paperclip, { size }),
  more: (size = 14) => lucideSvg(Ellipsis, { size }),
  /** Open folder in Cursor desktop editor. */
  openCursor: (size = 14) => lucideSvg(AppWindow, { size }),
  /** Deploy / build flow card. */
  flow: (size = 14) => lucideSvg(Workflow, { size }),
};
