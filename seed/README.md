# Telem, the Seed

Hey there. This seed is meant for an AI agent aiming to build an implementation of the Telem methodology for its user. If you're not an agent, please go read [How to use this seed](../README.md).

---

The outcome of growing this seed is a set of skills, scripts and tools that aim to build and maintain Telem-style tests in a repository. At times the seed might sound like it's talking about how to build the tests themselves, but **what we're building is the harness, not its outcome**.

You will be building all the [tools](./tools/README.md) and [skills](./skills/README.md) described in this repository.

## Platform-Specific vs. Platform-Agnostic Skills

First, decide which runtime and languages (henceforth "platform") you'll be targeting. While Telem as a methodology is platform-agnostic, it does have platform-specific parts as specialization.
Make sure you know what platform you're aiming for (ask the user if they have not specified it), and then examine [the shape of what you'll be building](./shape.md).

Platform-specific hints can be found in [hints](./hints/README.md).

## Context

### Principles

Read and constantly keep in mind [Telem’s Foundational Principles for Tests](./principles.md). They provide a beacon for how to author everything detailed here.
If you strongly believe you have to make compromises, you **must** get human approval after presenting the reasons for having to make that compromise, a proposal, and its pros and cons.

### Build-time vs. Run-time

You will be building the set of skills that AI agents will run to build Telem-style tests.
Keep and mind and distinguish between [what you'll be building at build-time](./shape.md) and [what the skills will output when they're used at run-time](./runtime-artifacts.md).

## Terms

These terms are used throughout the seed with one meaning each:

1. **Flow** (or business flow): a user-observable behavior of the system, and the unit of work that `backfill` processes. A **feature file** is the Gherkin that tests one flow. "Feature" on its own is avoided; a **feature flag** is always written in full.
2. **Scenario context**: the per-scenario object that carries the scenario ID and the seeding, failure-injection and ownership helpers. It's called the **World** in Cucumber-JS and `context` in behave. The seed says "World" for short; use your framework's equivalent.

## Recurring references to tools

These tools are mentioned in this seed, explained here to disambiguate:

1. [`crit`](https://crit.md) - a tool that lets users review an agent's outputs and have a discussion with it. The user of this implementation of Telem may standardize on a different tool. To decide what to use in its place, read about what `crit` does at https://crit.md.

There are also tools referenced that you will be building. They're listed in the [Tool Seeds readme](tools/README.md).

## Methodologies

The following are How-Tos for that are perpendicular to the skills. You will incorporate them into the skills and tools you create:

1. [Fakes](fakes.md).
2. [Discovery](discovery.md).
2. [Scenario Design](scenario-design.md).
