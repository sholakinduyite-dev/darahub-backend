// Starting values for shop rules. These are sensible defaults, NOT decisions: the owner should confirm each one.
// They are copied into the Setting table by the seed script and can be changed there (an admin screen comes later).
export const DEFAULT_SETTINGS: Record<string, unknown> = {
  stock_hold_minutes: 10, // how long items are reserved during checkout
  unpaid_order_hours: 24, // unpaid orders are cancelled after this
  return_window_days: 7,
  auto_confirm_days: 3, // delivered orders are confirmed automatically after this
  low_stock_threshold: 5,
  transfer_overdue_hours: 4, // alert when a bank transfer waits longer than this for approval
  verification_code_minutes: 10,
  verification_max_attempts: 5,
  resend_wait_seconds: 60,
  login_max_tries: 5,
  login_lock_minutes: 15,
};
