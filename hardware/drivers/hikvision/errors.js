// HCNetSDK error codes → human messages.
// Names and meanings from Hikvision's "Device Network SDK Error Codes" list
// (NET_DVR_PASSWORD_ERROR = 1, NET_ERR_USERNAME_LOCKED = 153, …).
const MAP = {
  0: 'Success',
  1: 'Wrong user name or password.',
  2: 'This user is not allowed to do that on the controller.',
  3: 'The Hikvision SDK is not initialised.',
  4: 'That channel or door does not exist on this controller.',
  5: 'Too many connections to the controller — close iVMS-4200 or other apps logged in to it.',
  6: 'SDK version does not match the controller — update the HCNetSDK files.',
  7: 'Could not connect to the controller.',
  8: 'Could not send data to the controller.',
  9: 'Could not receive data from the controller.',
  10: 'The controller did not reply in time.',
  11: 'The controller sent back data the SDK could not read.',
  12: 'SDK calls made in the wrong order.',
  13: 'Not allowed to do that on the controller.',
  14: 'The controller took too long to carry out the command.',
  17: 'Parameter error — the door number or command is invalid.',
  23: 'The controller does not support this function.',
  29: 'The controller could not carry out the command.',
  41: 'The SDK ran out of resources.',
  43: 'SDK buffer too small.',
  47: 'That user does not exist on the controller.',
  52: 'Too many users are logged in to the controller.',
  152: 'That user name does not exist on the controller.',
  153: 'The controller has locked this login after too many wrong passwords.',
  154: 'Invalid login session.',
  155: 'Login protocol too old for this controller — update the HCNetSDK files.',
  250: 'The controller has not been activated yet.',
};

function human(code) {
  const n = Number(code);
  return MAP[n] || `SDK error ${n}`;
}

const LOCK_HINT =
  'Put the correct password in the Lane wizard, then power the controller off and on (or wait about 30 minutes) to unlock it. ' +
  'The bridge stops retrying a password the controller refused, so it will not lock it again.';

/**
 * What a failed NET_DVR_Login_V40 means and what to do about it. `credential`
 * failures must not be retried with the same password: Hikvision controllers
 * lock the account after a handful of wrong tries (error 153).
 */
function describeLogin(code, where) {
  const n = Number(code);
  const at = where ? ` (${where})` : '';
  const base = { message: `${human(n)} [SDK error ${n}]`, credential: false };
  switch (n) {
    case 1:
      return { ...base, code: 'WRONG_PASSWORD', credential: true,
        hint: `The controller${at} refused the user name or password. Check them in the Lane wizard — the controller locks the login after about 5 wrong tries.` };
    case 47:
    case 152:
      return { ...base, code: 'UNKNOWN_USER', credential: true,
        hint: `There is no such user on the controller${at}. Use the controller's admin user (usually "admin") in the Lane wizard.` };
    case 153:
      return { ...base, code: 'ACCOUNT_LOCKED', credential: true, hint: LOCK_HINT };
    case 250:
      return { ...base, code: 'NOT_ACTIVATED', credential: true,
        hint: `Activate the controller${at} with Hikvision SADP (it sets the admin password), then enter that password in the Lane wizard.` };
    case 5:
    case 52:
      return { ...base, code: 'TOO_MANY_CONNECTIONS',
        hint: 'Log out of the controller in iVMS-4200, Hik-Connect or its web page on other devices, then retry.' };
    case 6:
    case 155:
      return { ...base, code: 'SDK_MISMATCH',
        hint: 'Install the latest Hikvision HCNetSDK files for this controller (see INSTALL-HIKVISION.md), then press Retry SDK.' };
    case 7:
    case 8:
    case 9:
    case 10:
      return { ...base, code: 'CONTROLLER_UNREACHABLE',
        hint: `Check the controller${at} is powered and on this network, and that SDK port 8000 is open (Hikvision controllers often ignore ping).` };
    default:
      return { ...base, code: 'LOGIN_FAILED',
        hint: `Login to ${where || 'the controller'} failed. Check the address, SDK port 8000 and the admin password in the Lane wizard.` };
  }
}

module.exports = { human, describeLogin };
