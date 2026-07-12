---
type: spec
created: 2026-07-11
updated: 2026-07-11
sources:
  - "[[wiki/specs/product-host]]"
  - "[[wiki/specs/capture]]"
  - "[[wiki/specs/adoption]]"
  - "[[wiki/invariants/PROPOSALS_ARE_THE_ONLY_WRITE_PATH]]"
description: "Controlled mutation module: expected-byte admission, host-coordinated commit, crash journal, and conservative checkout repair."
status: active
---

# Controlled mutation

## Interface

`src/mutation/controlled-mutation.ts` is the single deep Module for
Dome-mediated workspace writes. It accepts:

```text
vault + branch + request id
+ one or more (path, expected bytes, desired bytes)
+ ordinary human commit message and author
```

It returns one of four operational results:

- `committed`: one attributable commit exists and checkout bytes were repaired
  or a later commit has superseded them;
- `no-commit`: admission detected different owner bytes, or a prepared
  candidate never landed;
- `diverged`: the commit landed but checkout bytes changed outside the request;
  the durable journal remains for owner recovery;
- `busy`: the bounded host/mutation lock wait expired.

This does not add an engine primitive or public proposal submission API. The
commit is an ordinary writer commit; branch drift still becomes a Proposal and
the engine remains the only adopter/applier.

## Transaction sequence

1. Acquire the existing per-branch compiler-host lock, then the per-branch
   controlled-mutation lock.
2. Replay any surviving branch-finalize intent and reconcile any surviving
   controlled-mutation journal.
3. Verify the checked-out branch, then compare every current working file with
   its caller-supplied expected bytes.
   Any mismatch returns `no-commit` without writing.
4. Build the candidate commit from the current HEAD tree plus desired blobs.
   Append `Dome-Request: <request id>` for durable operation attribution; this
   is not one of the engine-authenticity trailers.
5. Before branch CAS, atomically persist both the request journal and the
   existing finalize intent.
6. Advance the branch by compare-and-swap.
7. Materialize only when current bytes still equal expected bytes. Never
   replace bytes that match neither expected nor desired.
8. Synchronize touched index entries best-effort and clear both journals only
   after verified reconciliation.

The journal lives under `.dome/state/mutations/` and is operational state, not
Markdown truth. It contains expected and desired bytes because recovery must
make a byte-exact overwrite decision after process death. It is gitignored and
must receive the same local filesystem protection as the vault.

## Recovery outcomes

Recovery first checks whether the journaled candidate is the branch head or an
ancestor of it.

- Candidate absent: no commit landed; clear the intent. The Module wrote no
  workspace bytes.
- Candidate present and current bytes equal desired: clear the intent.
- Candidate present and current bytes equal expected: materialize desired,
  repair the index, verify, then clear.
- Candidate present and current bytes match neither: preserve them and retain
  the journal as explicit divergence.
- A later branch commit changed the same path: the later branch truth
  supersedes this checkout intent; never restore the older blob.

The engine's finalize journal and the controlled-mutation journal are composed,
not competing recovery systems: the former proves the ref/materialization
move; the latter carries request identity and expected-byte authority.

## Adoption status

Capture is the first migrated consumer. Its browser receipt distinguishes
`committed` from `adopted`; controlled mutation stops at the ordinary commit
boundary. Settle, proposal apply, retrieval-miss logging, and hosted-agent
authoring remain migration work and must move through the same Interface before
remote product exposure.
