/** Reset wipes + reseeds the synthetic graph. Requires explicit confirmation. */
export function confirmResetDemo(): Promise<boolean> {
  return Promise.resolve(
    window.confirm(
      'Reset demo?\n\nThis clears the MemoryGuard graph and reseeds the SYNTHETIC demonstration dataset. ' +
        'Any memories you added and containment state will be replaced by the demo seed.\n\nContinue?',
    ),
  );
}
