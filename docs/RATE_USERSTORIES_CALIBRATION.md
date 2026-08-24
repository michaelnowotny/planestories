# Calibration corpus for `/rate-userstories`

A rubric is a check, and **a check nobody has watched fail is not a check.** These are specimens
with a stated expected verdict. Run `/rate-userstories` over this file after any rubric change; if a
specimen's verdict moves, either the change is wrong or the expectation was.

**What this is not.** It is not the experiment the research session asked for — scoring tickets whose
real *outcomes* are known, to see whether the rubric separates the ones that shipped clean from the
ones that produced rework. That is the right study and it is described at the bottom; we cannot run
it yet because outcomes are not recorded on the board. This corpus is the cheap thing available now:
a regression test that pins the rubric against shapes we already know are good or bad.

---

## S1 — Dilution. **Must FAIL.** (Old rubric: near-exemplary.)

The shape that motivated the revision: twenty criteria, roughly four of which are gates. Every
criterion has a clean pass/fail; concrete values throughout; happy path, errors and edges all
"covered". Two defects shipped from a spec of this shape and **neither was in any of the twenty.**

Abbreviated — the ratio is the point, not the prose:

> 1. *"The γ₀ == 0 rate stays within [38.3%, 47.9%] on the reference day; below the floor FAILS."* — **gate**
> 2. *"A day with zero eligible trades is recorded as SKIPPED, never as a zero estimate."* — **gate**
> 3. *"Estimates are byte-identical across two runs of the same input."* — **gate**
> 4. *"A window shorter than the configured minimum is rejected, not silently widened."* — **gate**
> 5. *"Dead branches removed, with 'no consumer found' recorded per branch."* — task
> 6. *"The helper is extracted into `estimators/common.ts`."* — task
> 7. *"Logging uses the structured logger."* — task
> 8. *"The migration file is numbered sequentially."* — task
> … 12 more of the same shape …

**Expected:** Discrimination ≈ 4/20 → **FAIL**, with a recommendation to delete the sixteen tasks —
**not** to delete criteria in general, and **not** to split. Notes must say the four gates are
diluted, not that the story is too big.

Under the previous rubric this scored high on all four dimensions, which is the finding.

## S2 — Lean. **Must PASS.**

The same four gates as S1, one task, nothing else. Same work, one-fifth the reading.

**Expected:** Discrimination ≈ 4/5 → **PASS**. If S2 does not outscore S1 by a wide margin, the
revision failed.

## S3 — Closed enumeration. **Must be FLAGGED even though every criterion is precise.**

> *"The diagnostic row contains the columns `estimator`, `window`, `n_trades`, `gamma0`, `status`."*

Quantified, unambiguous, trivially testable, and it excludes nothing: produce those five and it
passes forever, including on the day someone needs to know *why* the estimator failed and no column
carries it. This is the criterion that failed in the real incident.

**Expected:** flagged as *closed enumeration as coverage*, with the generative rewrite — *"for every
way the estimator can fail, the diagnostic row identifies which failure occurred"*. It must NOT be
praised for specificity.

## S4 — No outcome delta. **Must FAIL at the 75% cap.**

Five genuine gates, well written, no sentence anywhere stating what is true after it lands that is
not true now. The body describes work to be done.

**Expected:** capped at **75% → FAIL**, mirroring the epic's missing-rationale cap. A story whose
post-condition cannot be stated is either not one story or not yet understood.

## S5 — Measurement smuggling. **Must be FLAGGED, and must not gain Specificity for it.**

> *"Baseline p95 is 812ms as measured on 2026-08-19 across 4,102 requests."*

A true, precise, well-sourced sentence that **cannot fail** — it is a fact about the past, not a
condition on the build. It belongs in the body as the justification; the criterion is the line the
number argues for (*"p95 stays under 400ms on the same corpus"*).

**Expected:** flagged, classified as a **task** (not a gate), moved to the body in the replacement
markdown.

## S6 — Genuinely large. **Must PASS, with a SPLIT recommendation and NO count penalty.**

Ten criteria, nine of them gates. This is the guard against the perverse incentive: penalising the
raw criterion count would push an author to delete gates to score better, which is worse than the
disease.

**Expected:** Discrimination ≈ 9/10 → high. **PASS.** A recommendation to split it into two stories
because ten distinct failure modes is two stories' worth of risk — offered as scope advice, never as
a score penalty, and never as "remove some criteria".

If S6 fails or is told to trim, the revision has introduced a worse problem than the one it fixed.

---

## S7 — A perfect gate that is UNSATISFIABLE. **Must be FLAGGED as a structural finding.**

Contributed by the research session, from a real ticket (CFAP-96 G2):

> *"size measured on perfect PITs at N ∈ {50,100,200,500,1000} is within 2 SE of nominal at every
> cell."*

Score it against every other test in this rubric and it wins. It can fail; its failure changes the
decision; it is not a task; it is not a smuggled measurement; it is not a closed enumeration — it
quantifies generatively over cells. It excludes a large set of worlds.

**And no correct implementation could ever satisfy it.** A deterministic test on a discrete statistic
cannot attain exact nominal size at every N: at N = 200, `k = 0` alone has asymptotic p < 0.05 and
occurs 13.4% of the time under the null. The builder marked those rows unquotable with the reason
rather than laundering the discreteness into a pass — the right call, but the criterion was wrong
when it was written.

**Expected:** flagged as an **unsatisfiable gate** — a structural finding, not a score deduction —
with the achievable restatement offered. It must NOT be praised as a strong gate, and it must not be
confused with the closed-enumeration finding (S3): S3's criterion is finite where reality is open;
S7's is open where reality is bounded.

The rater question that catches it: **"name one build that would satisfy this."**

This is the specimen that shows satisfiability is not only a property of a criteria SET (do these
contradict each other?) but of a single criterion — and the set-level check passes here, which is why
it was missed.

## The study we cannot run yet, and how to make it runnable

The honest position: the revision is justified from first principles — **every dimension of the old
rubric was monotonic in writing effort, so it could not distinguish writing the right things from
writing more things** — and it is corroborated by one painful case. That is not the same as evidence
that it predicts outcomes.

The study that would settle it:

1. Take tickets whose outcomes are known — shipped clean / produced a defect / needed rework.
2. Score each under the old rubric and the new one, blind to the outcome.
3. Ask whether either separates the groups.

If the old rubric does not separate them and the new one does, that is evidence. **If neither
separates them, the rubric is decoration, and that is worth knowing more than a confirmation would
have been.**

**The blocker is step 1: outcomes are not recorded.** A ticket that produced two defects looks
exactly like one that shipped clean once it is Done. The cheap fix is to start recording the label
now, on the ticket, as evidence — the same same-turn discipline already used for commit SHAs:

```
planestories set DATA-123 --evidence "outcome: rework — two defects found in review, neither in the ACs"
planestories set DATA-124 --evidence "outcome: clean — shipped, no rework"
```

A year of that makes the study a morning's work. Without it, everyone rating tickets is doing what
we are doing here: reasoning carefully from a handful of cases and hoping.
