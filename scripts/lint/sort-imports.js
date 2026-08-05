// Alphabetises the import header, because `deno fmt` has no import option and
// `deno lint` ships no sorting rule — a lint plugin with a fix is the only way to
// get it without adding a formatter back (Biome was removed on purpose).
//
// Order: bare specifiers first, then `@/`, alphabetical within each group, a blank
// line between them. That is the convention the codebase already mostly followed.
//
// **Some imports are pinned, and that is the point.** Import order is not always
// cosmetic here: `@/lib/sentry.js` runs `Sentry.init` on evaluation, so it has to
// evaluate before the modules whose top-level code it is meant to capture. Two
// kinds of import therefore never move, and act as dividers the sortable runs
// around them respect:
//
//   - one with a comment above it — the comment explains the position, and moving
//     the import would strand the comment as well
//   - a side-effect import (`import "x"`), which has no bindings and exists purely
//     for the evaluation it triggers
//
// So this only ever reorders imports that carry no evidence their order matters.

const ALIAS_PREFIX = "@/";

// Codepoint comparison rather than localeCompare: the result has to be stable
// across machines, and a locale-aware collation is not.
const byText = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

const groupOf = (specifier) => (specifier.startsWith(ALIAS_PREFIX) ? 1 : 0);

function sortRun(run, textOf) {
    return [...run]
        .sort((a, b) =>
            groupOf(a.source.value) - groupOf(b.source.value) ||
            byText(a.source.value, b.source.value)
        )
        .reduce((lines, node, i, sorted) => {
            // Blank line where the group changes, so externals stay visually
            // separate from local modules.
            const newGroup = i > 0 && groupOf(sorted[i - 1].source.value) !== groupOf(node.source.value);
            return lines.concat(newGroup ? ["", textOf(node)] : [textOf(node)]);
        }, [])
        .join("\n");
}

const plugin = {
    name: "local",
    rules: {
        "sort-imports": {
            create(context) {
                const source = context.sourceCode;
                const textOf = (node) => source.getText(node);

                return {
                    Program(program) {
                        // Only the leading run of imports is the "header"; an import
                        // sitting after real code is deliberate and left alone.
                        const header = [];
                        for (const node of program.body) {
                            if (node.type !== "ImportDeclaration") break;
                            header.push(node);
                        }
                        if (header.length < 2) return;

                        const pinned = (node, i) =>
                            node.specifiers.length === 0 ||
                            (i > 0 && source.getCommentsBefore(node).length > 0);

                        // Split on pinned imports: each sortable run is sorted in
                        // place, so nothing crosses a divider.
                        const runs = [];
                        let run = [];
                        header.forEach((node, i) => {
                            if (pinned(node, i)) {
                                if (run.length) runs.push(run);
                                run = [];
                                return;
                            }
                            run.push(node);
                        });
                        if (run.length) runs.push(run);

                        for (const group of runs) {
                            if (group.length < 2) continue;
                            const wanted = sortRun(group, textOf);
                            // Compare the rendered span, not just specifier order, so
                            // the blank-line grouping is enforced too.
                            const span = [group[0].range[0], group.at(-1).range[1]];
                            if (source.text.slice(span[0], span[1]) === wanted) continue;
                            context.report({
                                node: group[0],
                                message: "Imports are not sorted (bare specifiers, then @/, alphabetical).",
                                fix: (fixer) => fixer.replaceTextRange(span, wanted),
                            });
                        }
                    },
                };
            },
        },
    },
};

export default plugin;
