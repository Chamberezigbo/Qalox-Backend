/**
 * Marketer Commission Override API Tests
 *
 * Tests the per-marketer commission rate configuration logic:
 * - Commission rate precedence (custom > legacy > global default)
 * - First payment vs. renewal rate selection
 * - Edge case handling
 */

const { selectMarketerCommissionRate } = require('../controller/public/publicController');

describe('Marketer Commission Override API', () => {
  // Test settings object
  const settings = {
    commissionRate: 5.0,
    firstPaymentCommissionRate: 7.0,
    renewalCommissionRate: 4.0,
  };

  describe('selectMarketerCommissionRate helper', () => {
    test('returns global default when marketer has no overrides', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 0, newSchoolCommissionRate: null, renewalCommissionRate: null },
        isFirstPayment: true,
        settings,
      });

      expect(rate).toBe(settings.firstPaymentCommissionRate);
    });

    test('returns custom new-school rate when set', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 0, newSchoolCommissionRate: 10.0, renewalCommissionRate: null },
        isFirstPayment: true,
        settings,
      });

      expect(rate).toBe(10.0);
    });

    test('returns custom renewal rate when set', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 0, newSchoolCommissionRate: null, renewalCommissionRate: 6.0 },
        isFirstPayment: false,
        settings,
      });

      expect(rate).toBe(6.0);
    });

    test('uses legacy commissionRate as fallback when custom rates are not set', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 8.0, newSchoolCommissionRate: null, renewalCommissionRate: null },
        isFirstPayment: true,
        settings,
      });

      expect(rate).toBe(8.0);
    });

    test('prioritizes custom new-school rate over legacy commissionRate', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 8.0, newSchoolCommissionRate: 12.0, renewalCommissionRate: null },
        isFirstPayment: true,
        settings,
      });

      expect(rate).toBe(12.0);
    });

    test('handles null marketer gracefully', () => {
      const rate = selectMarketerCommissionRate({
        marketer: null,
        isFirstPayment: true,
        settings,
      });

      expect(rate).toBeNull();
    });

    test('uses default renewal rate when no override and no legacy rate', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 0, newSchoolCommissionRate: null, renewalCommissionRate: null },
        isFirstPayment: false,
        settings,
      });

      expect(rate).toBe(settings.renewalCommissionRate);
    });
  });

  describe('Commission Rate Precedence', () => {
    test('new-school: custom > legacy > global default', () => {
      // Scenario 1: All set
      let rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 5.0, newSchoolCommissionRate: 15.0, renewalCommissionRate: 3.0 },
        isFirstPayment: true,
        settings,
      });
      expect(rate).toBe(15.0); // Custom wins

      // Scenario 2: No custom, only legacy
      rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 5.0, newSchoolCommissionRate: null, renewalCommissionRate: 3.0 },
        isFirstPayment: true,
        settings,
      });
      expect(rate).toBe(5.0); // Legacy wins

      // Scenario 3: No custom, no legacy
      rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 0, newSchoolCommissionRate: null, renewalCommissionRate: 3.0 },
        isFirstPayment: true,
        settings,
      });
      expect(rate).toBe(settings.firstPaymentCommissionRate); // Global default
    });

    test('renewal: custom > legacy > global default', () => {
      // Scenario 1: All set
      let rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 5.0, newSchoolCommissionRate: 15.0, renewalCommissionRate: 3.0 },
        isFirstPayment: false,
        settings,
      });
      expect(rate).toBe(3.0); // Custom wins

      // Scenario 2: No custom, only legacy
      rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 5.0, newSchoolCommissionRate: 15.0, renewalCommissionRate: null },
        isFirstPayment: false,
        settings,
      });
      expect(rate).toBe(5.0); // Legacy wins

      // Scenario 3: No custom, no legacy
      rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 0, newSchoolCommissionRate: 15.0, renewalCommissionRate: null },
        isFirstPayment: false,
        settings,
      });
      expect(rate).toBe(settings.renewalCommissionRate); // Global default
    });
  });

  describe('Edge Cases', () => {
    test('zero custom rate is valid (not treated as missing)', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 0, newSchoolCommissionRate: 0, renewalCommissionRate: null },
        isFirstPayment: true,
        settings,
      });

      expect(rate).toBe(0); // Explicit 0% override
    });

    test('handles missing global settings gracefully', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 0, newSchoolCommissionRate: null, renewalCommissionRate: null },
        isFirstPayment: true,
        settings: { firstPaymentCommissionRate: null, renewalCommissionRate: null, commissionRate: null },
      });

      expect(rate).toBe(0); // Falls back to 0 when all are null
    });

    test('handles undefined settings gracefully', () => {
      const rate = selectMarketerCommissionRate({
        marketer: { commissionRate: 5.0, newSchoolCommissionRate: null, renewalCommissionRate: null },
        isFirstPayment: true,
        settings: undefined,
      });

      expect(rate).toBe(5.0); // Falls back to legacy rate
    });
  });
});
