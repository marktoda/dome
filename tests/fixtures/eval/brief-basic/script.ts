// Thin re-export shim. Constants have moved to src/eval/cases/brief-fixtures.ts
// to avoid the inverted src→tests code import. This file is kept so that any
// future test helper that is not yet updated can still resolve its imports
// without a hard error.
export {
  BRIEF_BASIC_SCRIPT,
  FIRED_AT,
  TODAY_DAILY_PATH,
  YESTERDAY_DAILY_PATH,
} from "../../../../src/eval/cases/brief-fixtures";
