import { defineRule } from "@oxlint/plugins";

import type { ESTree } from "@oxlint/plugins";

type RuntimeFunction = ESTree.ArrowFunctionExpression | ESTree.Function;

function isRuntimeFunction(node: ESTree.Node): node is RuntimeFunction {
	return (
		node.type === "ArrowFunctionExpression" ||
		node.type === "FunctionDeclaration" ||
		node.type === "FunctionExpression"
	);
}

function enclosingRuntimeFunction(node: ESTree.Node): RuntimeFunction | null {
	let current: ESTree.Node | null = node.parent;
	while (current !== null && current.type !== "Program") {
		if (isRuntimeFunction(current)) return current;
		current = current.parent;
	}
	return null;
}

function parameterHasUnknownAnnotation(parameter: ESTree.ParamPattern): boolean {
	if (parameter.type === "TSParameterProperty") return parameterHasUnknownAnnotation(parameter.parameter);
	if (parameter.type === "RestElement") {
		return (
			parameter.typeAnnotation?.typeAnnotation.type === "TSUnknownKeyword" ||
			parameterHasUnknownAnnotation(parameter.argument)
		);
	}
	if (parameter.type === "AssignmentPattern") {
		return (
			parameter.typeAnnotation?.typeAnnotation.type === "TSUnknownKeyword" ||
			parameter.left.typeAnnotation?.typeAnnotation.type === "TSUnknownKeyword"
		);
	}
	return parameter.typeAnnotation?.typeAnnotation.type === "TSUnknownKeyword";
}

function hasBoundaryComment(
	context: Readonly<{
		sourceCode: Readonly<{
			getCommentsBefore: (node: ESTree.Node) => readonly Readonly<{ value: string }>[];
		}>;
	}>,
	owner: RuntimeFunction,
): boolean {
	let current: ESTree.Node = owner;
	while (true) {
		if (context.sourceCode.getCommentsBefore(current).some((comment) => /\bBOUNDARY\s*:/u.test(comment.value))) {
			return true;
		}
		if (current.parent.type === "Program" || current.parent.type === "BlockStatement") return false;
		current = current.parent;
	}
}

/** Disallow runtime typeof checks that narrow unparsed values instead of decoding them. */
export const noRuntimeTypeofRule = defineRule({
	meta: {
		type: "problem",
		docs: {
			description:
				"Disallow runtime typeof checks; external values must be decoded into meaningful types at their I/O boundary.",
		},
		messages: {
			runtimeTypeof:
				"A `typeof` check narrows a representation without establishing its contract. Parse input at its I/O boundary, then branch on the domain value.",
		},
		schema: [
			{
				type: "object",
				properties: {
					allowInTypeGuards: { type: "boolean" },
				},
				additionalProperties: false,
			},
		],
		defaultOptions: [{ allowInTypeGuards: false }],
	},
	createOnce(context) {
		return {
			UnaryExpression(node) {
				const option = context.options?.[0];
				const allowInTypeGuards =
					typeof option === "object" &&
					option !== null &&
					!Array.isArray(option) &&
					option.allowInTypeGuards === true;
				if (node.operator !== "typeof") return;
				const owner = enclosingRuntimeFunction(node);
				if (owner === null) return;
				if (allowInTypeGuards && owner.returnType?.typeAnnotation.type === "TSTypePredicate") return;
				if (!owner.params.some(parameterHasUnknownAnnotation) || hasBoundaryComment(context, owner)) return;
				context.report({ node, messageId: "runtimeTypeof" });
			},
		};
	},
});
