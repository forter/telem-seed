# Telem, Keeping Agents in Check

![Telem logo](./assets/logo.png)

**Telem makes brownfield development with AI no longer scary.** It's a methodology that provides AI coding agents with a way to keep themselves in check, at its most effective in brownfield development.

### Want an Intro? Read _[Telem: Teaching Systems to Keep Promises](https://blog.forter.dev/telem-teaching-systems-to-keep-promises/)_ on the Forter Tech Blog

## Why a Seed?

Telem as a methodology is stable and sound, but the set of skills created for it should continue evolving and be optimized for each specific use case. "Planting" a seed and "growing" your own set of Telem skills lets you continue to grow it yourself, fitting it the way you, your team, and your organization works. Maybe you have a home-grown configuration system? Maybe you only use pure-functional programming? Grow your Telem implementation to be as specialized as you like.

### How to plant this seed

1. You're going to be guiding your agent on how to build it, so at the very least read the [blog post](https://blog.forter.dev/telem-teaching-systems-to-keep-promises/) and [principles](./seed/principles.md). Become opinionated.
2. Clone the repo to your machine, feed it to your AI, ask it to start reading the [seed's README.md](./seed/README.md) and to build you the set of skills described.
3. Iterate on the skills.
4. Provide [feedback](https://github.com/omervk/telem/issues) :)

## What Telem Is and Isn't

Telem is a way of working with AI agents in a sustainable way, using a set of skills. It aims to cover **functional requirements only**, through automated tests. It's not a complete solution nor is it a silver bullet.

Telem doesn't aim to:
- Test across boundaries (integration tests), only inside a defined blackbox of behaviors
- Check any non-functional requirements
- Have visibility into your Production environment or its telemetry
- Know whether a certain requirement is actually being used
- Enforce good design or architectural constraints

## Why "Telem"?

In Hebrew, a telem (תלם) is a furrow, and להשאר בתלם ("staying in the furrow") means to stay within the boundaries.
Along with other agricultural names and metaphors used throughout, like Cucumber and Brownfield, it was a perfect fit.
