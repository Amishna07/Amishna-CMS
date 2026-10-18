These three workbooks are the sanitized `CueExportTemplateData` templates embedded
in `frontend/public/dashboard.js` immediately before the September 2026 export
formatting update. They contain the application's existing labels and layout,
without uploaded production records or real user data.

The preservation tests use them as a fixed baseline to detect accidental changes
to values, formulas, labels, sheet order, merges, or number formats. They must not
be regenerated from the newly formatted templates when updating styles.

`iprs-movie-before.js` freezes the previous movie template transformation, whose
formatting was partly defined in code. It lets tests compare old and new movie
exports even when those hardcoded formatting choices change.

`prs-export-before.js` freezes the old PRS export mapping and renderer before
the user's subsequent request for the reference's exact merged layout. PRS
preservation checks map the old cell addresses into that requested layout and
rejoin its two note paragraphs, then compare every value, formula, type and
number format. Separate layout tests verify the reference merges and borders.

`references/IPRS.xlsx`, `references/PRS.xlsx`, and `references/ASCAP.xlsx` are the
unchanged Chashni workbooks supplied for the formatting comparison. They were
moved from the former `New One` folder so the regression tests retain their
original references while duplicate downloads and review artifacts are removed.
