import TokenActionPage from "../components/TokenActionPage";

/**
 * Double opt-in (/confirm-email?token=...): the link in the confirmation
 * e-mail. Alert e-mails go to an address only after its owner pressed the
 * button here (registration does not verify addresses).
 */
export default function ConfirmEmailPage() {
  return (
    <TokenActionPage
      title="Confirm alert e-mails"
      action="Yes, send alert e-mails to this address"
      endpoint="/api/email/confirm"
      intro={<p>Someone asked DisasterWatch to send disaster alert e-mails to this address. If that was you, confirm it below. If not, just close this page: nothing will be sent.</p>}
      done={
        <p>
          <strong>Confirmed.</strong> Alert e-mails will go to this address. Every e-mail has an unsubscribe link.
        </p>
      }
      invalid={<p>This confirmation link is not valid or was already used. You can turn e-mail alerts off and on again in the Alert center to get a new one.</p>}
    />
  );
}
