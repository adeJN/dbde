import {
  Activity,
  GitBranch,
  Info,
  Network,
  ArrowRightLeft,
} from "lucide-react";
export const TOOL_GROUPS = [
  { label: "Data", panes: ["Data Transfer", "Object Information"] },
  { label: "Query & Model", panes: ["Query Builder", "ER Model"] },
  { label: "Server", panes: ["Server Monitor"] },
] as const;
export type DatabaseToolPane = (typeof TOOL_GROUPS)[number]["panes"][number];
export const TOOL_ICONS = {
  "Data Transfer": ArrowRightLeft,
  "Object Information": Info,
  "Query Builder": GitBranch,
  "ER Model": Network,
  "Server Monitor": Activity,
} as const;
