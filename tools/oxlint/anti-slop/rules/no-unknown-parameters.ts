import { defineRule } from "@oxlint/plugins";
import type { ESTree } from "@oxlint/plugins";

type Parameter = ESTree.ParamPattern;
type ParameterOwner =
  | ESTree.ArrowFunctionExpression
  | ESTree.Function
  | ESTree.TSCallSignatureDeclaration
  | ESTree.TSConstructSignatureDeclaration
  | ESTree.TSConstructorType
  | ESTree.TSFunctionType
  | ESTree.TSMethodSignature;

function parameterAnnotation(parameter: Parameter): ESTree.TSTypeAnnotation | null | undefined {
  if (parameter.type === "TSParameterProperty") {
    return parameterAnnotation(parameter.parameter);
  }
  if (parameter.type === "RestElement") {
    return parameter.typeAnnotation ?? parameterAnnotation(parameter.argument);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameter.typeAnnotation ?? parameter.left.typeAnnotation;
  }
  return parameter.typeAnnotation;
}

function parameterName(parameter: Parameter, sourceText: string): string {
  if (parameter.type === "TSParameterProperty") {
    return parameterName(parameter.parameter, sourceText);
  }
  if (parameter.type === "AssignmentPattern") {
    return parameterName(parameter.left, sourceText);
  }
  if (parameter.type === "RestElement") {
    return parameterName(parameter.argument, sourceText);
  }
  return parameter.type === "Identifier"
    ? parameter.name
    : sourceText.replace(/\s*:\s*unknown\s*$/u, "");
}

function establishesRuntimeContract(owner: ParameterOwner): boolean {
  return owner.returnType?.typeAnnotation.type === "TSTypePredicate";
}

function hasBoundaryComment(
  context: Readonly<{
    sourceCode: Readonly<{
      getCommentsBefore: (node: ESTree.Node) => readonly Readonly<{ value: string }>[];
    }>;
  }>,
  owner: ParameterOwner,
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

function parsesAtBoundary(owner: ParameterOwner, parameter: Parameter): boolean {
  if (parameter.type !== "Identifier") return false;
  if (
    owner.type !== "ArrowFunctionExpression" &&
    owner.type !== "FunctionDeclaration" &&
    owner.type !== "FunctionExpression"
  )
    return false;
  const body = owner.body;
  const boundaryNode = body.type === "BlockStatement" ? body.body[0] : body;
  if (boundaryNode === undefined) return false;
  let parsed = false;
  const visit = (node: ESTree.Node) => {
    if (parsed) return;
    if (
      node.type === "CallExpression" &&
      node.callee.type === "MemberExpression" &&
      !node.callee.computed &&
      node.callee.property.type === "Identifier" &&
      (node.callee.property.name === "parse" || node.callee.property.name === "safeParse") &&
      node.arguments.some(
        (argument) => argument.type !== "SpreadElement" && argument.type === "Identifier" && argument.name === parameter.name,
      )
    ) {
      parsed = true;
      return;
    }
    for (const key of Object.keys(node)) {
      if (key === "parent") continue;
      const child = node[key as keyof typeof node];
      if (Array.isArray(child)) {
        for (const item of child) if (item && typeof item === "object" && "type" in item) visit(item as ESTree.Node);
      } else if (child && typeof child === "object" && "type" in child) {
        visit(child as ESTree.Node);
      }
    }
  };
  visit(boundaryNode);
  return parsed;
}

/** Disallow unknown inputs except explicitly named error-cause enrichment. */
export const noUnknownParametersRule = defineRule({
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow explicitly unknown function parameters except `cause`; decode unknown input at its I/O boundary instead.",
    },
    messages: {
      unknownParameter:
        "Parameter `{{parameter}}` leaves input unparsed. Accept a named domain type; run the expected schema or parser at the I/O boundary before calling this function.",
    },
  },
  createOnce(context) {
    const checkParameters = (node: ParameterOwner) => {
      if (establishesRuntimeContract(node)) return;
      if (hasBoundaryComment(context, node)) return;
      for (const parameter of node.params) {
        const annotation = parameterAnnotation(parameter);
        if (annotation?.typeAnnotation.type !== "TSUnknownKeyword") continue;
        const name = parameterName(parameter, context.sourceCode.getText(parameter));
        if (name === "cause") continue;
        if (parsesAtBoundary(node, parameter)) continue;
        context.report({
          node: annotation.typeAnnotation,
          messageId: "unknownParameter",
          data: { parameter: name },
        });
      }
    };

    return {
      ArrowFunctionExpression: checkParameters,
      FunctionDeclaration: checkParameters,
      FunctionExpression: checkParameters,
      TSCallSignatureDeclaration: checkParameters,
      TSConstructSignatureDeclaration: checkParameters,
      TSConstructorType: checkParameters,
      TSDeclareFunction: checkParameters,
      TSEmptyBodyFunctionExpression: checkParameters,
      TSFunctionType: checkParameters,
      TSMethodSignature: checkParameters,
    };
  },
});
