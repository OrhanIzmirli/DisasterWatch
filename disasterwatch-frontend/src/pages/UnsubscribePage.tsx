import TokenActionPage from "../components/TokenActionPage";

/**
 * Target of the unsubscribe link in every alert e-mail (/unsubscribe?token=...).
 * No sign-in; one button press switches e-mail alerts off and the page
 * confirms it. Mail clients that support RFC 8058 unsubscribe in one click
 * without this page (List-Unsubscribe-Post header).
 */
export default function UnsubscribePage() {
  return (
    <TokenActionPage
      title="Unsubscribe"
      action="Unsubscribe from alert e-mails"
      endpoint="/api/email/unsubscribe"
      intro={<p>Stop DisasterWatch alert e-mails to this address? Your alerts and in-app notifications stay as they are.</p>}
      done={
        <>
          <p>
            <strong>You are unsubscribed.</strong> DisasterWatch will not send you alert e-mails any more.
          </p>
          <p className="muted">Your alerts and in-app notifications are unchanged. You can turn e-mails back on in the Alert center.</p>
        </>
      }
      invalid={<p>This unsubscribe link is not valid. If you still get alert e-mails, sign in and turn them off in the Alert center.</p>}
    />
  );
}
