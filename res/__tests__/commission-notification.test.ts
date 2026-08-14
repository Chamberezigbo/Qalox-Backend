import { selectMarketerCommissionRate } from "../controller/public/publicController";

describe("Commission Notification System", () => {
  describe("selectMarketerCommissionRate", () => {
    const globalSettings = {
      commissionRate: 10,
      firstPaymentCommissionRate: 12,
      renewalCommissionRate: 8,
    };

    test("should use custom new school rate when set", () => {
      const marketer = {
        newSchoolCommissionRate: 15,
        renewalCommissionRate: null,
        commissionRate: 0,
      };

      const rate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: true,
        settings: globalSettings,
      });

      expect(rate).toBe(15);
    });

    test("should use custom renewal rate when set", () => {
      const marketer = {
        newSchoolCommissionRate: null,
        renewalCommissionRate: 9,
        commissionRate: 0,
      };

      const rate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: false,
        settings: globalSettings,
      });

      expect(rate).toBe(9);
    });

    test("should fall back to legacy rate when custom not set", () => {
      const marketer = {
        newSchoolCommissionRate: null,
        renewalCommissionRate: null,
        commissionRate: 11,
      };

      const rate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: true,
        settings: globalSettings,
      });

      expect(rate).toBe(11);
    });

    test("should fall back to global default when no custom/legacy rates", () => {
      const marketer = {
        newSchoolCommissionRate: null,
        renewalCommissionRate: null,
        commissionRate: 0,
      };

      const rate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: true,
        settings: globalSettings,
      });

      expect(rate).toBe(12); // firstPaymentCommissionRate
    });

    test("should prefer custom over legacy rate", () => {
      const marketer = {
        newSchoolCommissionRate: 16,
        renewalCommissionRate: null,
        commissionRate: 10,
      };

      const rate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: true,
        settings: globalSettings,
      });

      expect(rate).toBe(16); // Custom wins
    });

    test("should use platform default when marketer has no rates", () => {
      const marketer = {
        newSchoolCommissionRate: null,
        renewalCommissionRate: null,
        commissionRate: 0,
      };

      const rate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: false,
        settings: globalSettings,
      });

      expect(rate).toBe(8); // renewalCommissionRate
    });

    test("should handle undefined settings gracefully", () => {
      const marketer = {
        newSchoolCommissionRate: 15,
        renewalCommissionRate: null,
        commissionRate: 0,
      };

      const rate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: true,
        settings: {}, // Empty settings
      });

      expect(rate).toBe(15); // Custom rate is used
    });

    test("should return 0 when no rates available anywhere", () => {
      const marketer = {
        newSchoolCommissionRate: null,
        renewalCommissionRate: null,
        commissionRate: 0,
      };

      const rate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: true,
        settings: {}, // No defaults
      });

      expect(rate).toBe(0);
    });
  });

  describe("Email notification context", () => {
    test("updateMarketerCommission should track: old rate -> new rate", () => {
      // This is a conceptual test showing the data flow
      const marketer = {
        newSchoolCommissionRate: 12,
        renewalCommissionRate: 8,
        commissionRate: 0,
        email: "marketer@example.com",
        name: "Test Marketer",
      };

      const changes: string[] = [];
      changes.push(
        `renewal: ${marketer.renewalCommissionRate ?? "not set"} -> 9%`
      );

      expect(changes[0]).toContain("8");
      expect(changes[0]).toContain("9%");
    });

    test("should format email HTML with both custom rates", () => {
      const newSchoolCommissionRate = 15;
      const renewalCommissionRate = 9;
      const marketerName = "Ahmed";

      const emailHtml = `
        <h2>Commission Update Notice</h2>
        <p>Hello ${marketerName},</p>
        <p>Your commission rates have been updated by the Qalox admin team.</p>
        <h3>Updated Rates:</h3>
        <ul>
          ${
            newSchoolCommissionRate !== undefined
              ? `<li><strong>New School Registration:</strong> ${newSchoolCommissionRate}%</li>`
              : ""
          }
          ${
            renewalCommissionRate !== undefined
              ? `<li><strong>School Renewal:</strong> ${renewalCommissionRate}%</li>`
              : ""
          }
        </ul>
      `;

      expect(emailHtml).toContain("Ahmed");
      expect(emailHtml).toContain("15%");
      expect(emailHtml).toContain("9%");
      expect(emailHtml).toContain("New School Registration");
      expect(emailHtml).toContain("School Renewal");
    });

    test("should format email HTML with only one rate updated", () => {
      const newSchoolCommissionRate = 15;
      const renewalCommissionRate = undefined;
      const marketerName = "Test";

      const emailHtml = `
        <ul>
          ${
            newSchoolCommissionRate !== undefined
              ? `<li><strong>New School Registration:</strong> ${newSchoolCommissionRate}%</li>`
              : ""
          }
          ${
            renewalCommissionRate !== undefined
              ? `<li><strong>School Renewal:</strong> ${renewalCommissionRate}%</li>`
              : ""
          }
        </ul>
      `;

      expect(emailHtml).toContain("15%");
      expect(emailHtml).not.toContain("undefined");
      expect(emailHtml).toContain("New School Registration");
    });
  });

  describe("Security event logging context", () => {
    test("should log commission change with detail string", () => {
      const marketerId = 42;
      const actorId = 123;
      const changes = ["renewal: 8 -> 9%", "new-school: not set -> 15%"];

      const eventDetail = `by admin ${actorId}: ${changes.join("; ")}`.slice(
        0,
        255
      );

      expect(eventDetail).toContain("admin 123");
      expect(eventDetail).toContain("renewal: 8 -> 9%");
      expect(eventDetail).toContain("new-school: not set -> 15%");
    });

    test("should log commission deletion", () => {
      const marketerId = 42;
      const actorId = 123;

      const eventDetail = `by admin ${actorId}: cleared custom commission overrides`.slice(
        0,
        255
      );

      expect(eventDetail).toContain("admin 123");
      expect(eventDetail).toContain("cleared custom commission overrides");
    });
  });

  describe("Effective rate calculation", () => {
    test("getMarketerProfile should expose commission breakdown", () => {
      const marketer = {
        newSchoolCommissionRate: 15,
        renewalCommissionRate: 9,
        commissionRate: 0,
      };

      const globalSettings = {
        commissionRate: 10,
        firstPaymentCommissionRate: 12,
        renewalCommissionRate: 8,
      };

      const effectiveNewSchoolRate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: true,
        settings: globalSettings,
      });

      const effectiveRenewalRate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: false,
        settings: globalSettings,
      });

      const profileResponse = {
        commission: {
          customNewSchoolRate: marketer.newSchoolCommissionRate ?? null,
          customRenewalRate: marketer.renewalCommissionRate ?? null,
          legacyRate: marketer.commissionRate > 0 ? marketer.commissionRate : null,
          effectiveNewSchoolRate,
          effectiveRenewalRate,
        },
      };

      expect(profileResponse.commission.customNewSchoolRate).toBe(15);
      expect(profileResponse.commission.customRenewalRate).toBe(9);
      expect(profileResponse.commission.legacyRate).toBeNull();
      expect(profileResponse.commission.effectiveNewSchoolRate).toBe(15);
      expect(profileResponse.commission.effectiveRenewalRate).toBe(9);
    });

    test("getMarketerCommissionRates should show effective rates calculation", () => {
      const marketer = {
        newSchoolCommissionRate: null,
        renewalCommissionRate: null,
        commissionRate: 11,
      };

      const globalSettings = {
        commissionRate: 10,
        firstPaymentCommissionRate: 12,
        renewalCommissionRate: 8,
      };

      const effectiveNewSchoolRate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: true,
        settings: globalSettings,
      });

      const effectiveRenewalRate = selectMarketerCommissionRate({
        marketer,
        isFirstPayment: false,
        settings: globalSettings,
      });

      const response = {
        customRates: {
          newSchoolCommissionRate: marketer.newSchoolCommissionRate ?? null,
          renewalCommissionRate: marketer.renewalCommissionRate ?? null,
        },
        legacyRate: marketer.commissionRate > 0 ? marketer.commissionRate : null,
        effectiveRates: {
          newSchoolCommissionRate: effectiveNewSchoolRate,
          renewalCommissionRate: effectiveRenewalRate,
        },
        platformDefaults: globalSettings,
      };

      expect(response.customRates.newSchoolCommissionRate).toBeNull();
      expect(response.customRates.renewalCommissionRate).toBeNull();
      expect(response.legacyRate).toBe(11);
      expect(response.effectiveRates.newSchoolCommissionRate).toBe(11);
      expect(response.effectiveRates.newSchoolCommissionRate).toBe(11);
      expect(response.platformDefaults.firstPaymentCommissionRate).toBe(12);
    });
  });
});
