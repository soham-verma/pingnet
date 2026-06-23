# Contributing to Pingnet

Thanks for taking the time to contribute. This document covers how to report bugs, suggest features, and submit code.

---

## Before you start

- Search [existing issues](../../issues) before opening a new one — your question or bug may already be tracked.
- For large changes (new feature, architecture refactor), open a discussion issue first so we can agree on direction before you invest time writing code.

---

## Reporting bugs

Open an issue with:

1. **What you did** — exact steps to reproduce
2. **What you expected**
3. **What actually happened** — include any error messages or stack traces
4. **Environment** — OS, Pingnet version, Rust/Node versions if relevant

---

## Suggesting features

Open an issue tagged `enhancement`. Describe the problem you're trying to solve, not just the solution — it helps evaluate fit and alternatives.

---

## Development setup

```bash
# Clone
git clone https://github.com/your-org/pingnet.git
cd pingnet

# Install JS dependencies
npm install

# Run in dev mode
npm run tauri dev
```

> **Note:** The `ssh2` crate compiles OpenSSL from source on first build. Allow 3–5 minutes. Subsequent builds are fast.

### Toolchain versions

| Tool | Minimum |
|------|---------|
| Rust | stable (latest) |
| Node.js | 18 |
| npm | 9 |

---

## Submitting a pull request

1. Fork the repo and create a branch from `main`:
   ```bash
   git checkout -b fix/your-description
   ```

2. Make your changes. Keep commits focused — one logical change per commit.

3. Make sure TypeScript is clean:
   ```bash
   npx tsc --noEmit
   ```

4. Make sure Rust compiles:
   ```bash
   cargo check --manifest-path src-tauri/Cargo.toml
   ```

5. Open a PR against `main`. Describe what changed and why.

---

## Code style

**Rust**
- Follow `rustfmt` defaults (`cargo fmt`)
- Use `clippy` and address warnings (`cargo clippy`)

**TypeScript / React**
- Functional components with hooks only
- Keep components focused — if a file grows past ~300 lines, split it
- CSS via Tailwind utility classes; avoid inline styles except for dynamic values

**General**
- No commented-out code in PRs
- No `console.log` left in production paths

---

## Licence

By contributing, you agree that your contributions will be licensed under the [GPL v3](LICENSE).
