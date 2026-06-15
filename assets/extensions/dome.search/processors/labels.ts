// Shared display labels for dome.search view processors.

import type { FactEffect } from "../../../../src/core/effect";

import { claimLabel, parseClaimFact } from "./claims-fact";

const TASK_METADATA_MARKER =
  /(?:^|\s)(?:\u{1F4C5}\s*\d{4}-\d{2}-\d{2}|\u{1F53A}|\u{23EB}|\u{1F53C}|\u{1F53D}|\u{23EC})(?=\s|$)/gu;
const TASK_DUE_MARKER =
  /(?:^|\s)\u{1F4C5}\s*(\d{4}-\d{2}-\d{2})(?=\s|$)/u;

export function searchFactObjectLabel(fact: FactEffect): string {
  const claim = parseClaimFact(fact);
  if (claim !== null) return claimLabel(claim);
  const raw = objectLabel(fact.object);
  if (
    fact.object.kind !== "string" ||
    !(
      fact.predicate === "dome.daily.open_task" ||
      fact.predicate === "dome.daily.followup"
    )
  ) {
    return raw;
  }
  return searchDailyActionLabel(raw);
}

export function searchDailyActionLabel(text: string): string {
  return dailyActionLabel(text);
}

function objectLabel(value: FactEffect["object"]): string {
  if (value.kind === "string") return value.value;
  if (value.kind === "number") return String(value.value);
  if (value.kind === "date") return value.value;
  if (value.kind === "page") return value.path;
  if (value.kind === "task") return value.stableId;
  return value.name;
}

function dailyActionLabel(text: string): string {
  const stripped = stripDailyTaskMetadata(text);
  const dueDate = taskDueDate(text);
  const priority = taskPriority(text);
  const metadata = [
    dueDate === null ? null : `due: ${dueDate}`,
    priority === null ? null : `priority: ${priority}`,
  ].filter((item): item is string => item !== null);
  return metadata.length === 0 ? stripped : `${stripped} [${metadata.join(", ")}]`;
}

function stripDailyTaskMetadata(text: string): string {
  const stripped = text
    .replace(TASK_METADATA_MARKER, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  return stripped.length > 0 ? stripped : text;
}

function taskDueDate(text: string): string | null {
  return TASK_DUE_MARKER.exec(text)?.[1] ?? null;
}

function taskPriority(text: string): string | null {
  if (text.includes("\u{1F53A}")) return "highest";
  if (text.includes("\u{23EB}")) return "high";
  if (text.includes("\u{1F53C}")) return "medium";
  if (text.includes("\u{1F53D}")) return "low";
  if (text.includes("\u{23EC}")) return "lowest";
  return null;
}
