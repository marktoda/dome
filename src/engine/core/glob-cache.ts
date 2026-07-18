// Compatibility seam for existing engine and processor imports. The matcher
// and its sole cache now live in neutral core so content policy does not depend
// on capability machinery.
export { globMatch } from "../../core/glob-match";
