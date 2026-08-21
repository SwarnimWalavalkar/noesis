type PresentProperties<Value extends object> = {
  -readonly [Key in keyof Value]: Exclude<Value[Key], undefined>;
};

export interface ConditionalObjectBuilder<Value extends object> {
  add<Addition extends object>(addition: Addition): ConditionalObjectBuilder<Value & Addition>;
  addOptional<Addition extends object>(
    addition: Addition | undefined,
  ): ConditionalObjectBuilder<Value & Partial<PresentProperties<Addition>>>;
  finish(): Value;
}

function continueBuilding<Value extends object>(value: Value): ConditionalObjectBuilder<Value> {
  return {
    add<const Addition extends object>(addition: Addition) {
      const next = Object.assign(value, addition);
      // SAFETY: Object.assign has added every own property from Addition to the accumulator.
      return continueBuilding(next as Value & Addition);
    },
    addOptional<const Addition extends object>(addition: Addition | undefined) {
      if (addition !== undefined) Object.assign(value, addition);
      // SAFETY: an omitted addition contributes no required fields; a present one was assigned above.
      return continueBuilding(value as Value & Partial<PresentProperties<Addition>>);
    },
    finish() {
      return value;
    },
  };
}

/** Builds an object in evaluation order while keeping optional fields genuinely absent. */
export function createConditionalObject<Base extends object>(base: Base): ConditionalObjectBuilder<Base> {
  // The accumulator is private so fluent additions never mutate the caller's input object.
  return continueBuilding(Object.assign({}, base));
}
