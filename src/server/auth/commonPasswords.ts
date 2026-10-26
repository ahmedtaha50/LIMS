/**
 * Passwords that must never be accepted, however they are decorated. This is a short built-in list of the passwords and keyboard
 * walks that dominate public breach data plus words specific to this product; it is a floor, not a substitute for a screening
 * service, and an installation may extend it by editing this file under change control.
 */
export const COMMON_PASSWORDS: ReadonlySet<string> = new Set([
  'password', 'passw0rd', 'p@ssw0rd', 'p@ssword', 'pass1234', 'password1', 'password12', 'password123', 'password1234', '12345678', '123456789', '1234567890',
  '123456', '1234567', '111111', '000000', '121212', '123123', '654321', '666666', '696969', '987654321', 'qwerty', 'qwerty1', 'qwerty12', 'qwerty123',
  'qwertyuiop', 'qwertyui', 'asdfgh', 'asdfghjk', 'asdfghjkl', 'zxcvbnm', '1q2w3e4r', '1qaz2wsx', 'q1w2e3r4', 'qazwsx', 'zaq12wsx', 'abc123', 'abcd1234',
  'abcdefgh', 'letmein', 'letmein1', 'welcome', 'welcome1', 'welcome123', 'admin', 'admin123', 'admin1234', 'administrator', 'root', 'toor', 'login',
  'master', 'monkey', 'dragon', 'sunshine', 'princess', 'football', 'baseball', 'superman', 'batman', 'trustno1', 'iloveyou', 'shadow', 'michael',
  'jennifer', 'jordan', 'hunter', 'freedom', 'whatever', 'starwars', 'changeme', 'changeit', 'default', 'secret', 'test', 'test123', 'testing', 'guest',
  'user', 'user123', 'temp123', 'temporary', 'summer', 'winter', 'spring', 'autumn', 'january', 'february', 'march', 'april', 'cairo', 'egypt',
  'lims', 'lims123', 'gxp', 'gxp123', 'gxplims', 'bpharma', 'pharma', 'pharma123', 'laboratory', 'lab123', 'analyst', 'analyst123', 'reviewer', 'qa123',
]);

/** Fragments that make a password weak wherever they appear in it. */
export const BANNED_FRAGMENTS: readonly string[] = ['password', 'passw0rd', 'qwerty', 'letmein', 'iloveyou', '123456', 'abc123', 'changeme', 'welcome'];
