// Password rules shared by the login and registration sheets. Kept out of the
// views so the same minimum is enforced in one place.
export const PASSWORD_MIN = 8

// Returns an error message, or null when the pair is acceptable.
export function validatePassword(password, confirm) {
  if (password.length < PASSWORD_MIN) return 'Password must be at least ' + PASSWORD_MIN + ' characters'
  if (password !== confirm) return 'Passwords do not match'
  return null
}
