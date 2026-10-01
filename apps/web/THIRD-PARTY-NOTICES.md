# SecLists password denylist

`src/server/password-denylist.json` contains SHA-256 hashes of lowercase passwords of length 12–128 from SecLists `Passwords/Common-Credentials/xato-net-10-million-passwords-100000.txt`, plus the seven values from the prior local denylist. Shorter/longer values are already rejected by the password length rule. No entered password is sent to a remote service.

Source: https://github.com/danielmiessler/SecLists/blob/bd8f9b5501f9257e9d39c733540e793602c3da6f/Passwords/Common-Credentials/xato-net-10-million-passwords-100000.txt

Source SHA-256: `1472aafa2561df5e3293aee252aee3ca660c12b399a283cf808bb01b39be388b`.

This is a bounded list of common passwords, not a complete breached-password database. It does not replace MFA or login rate limits.

MIT License

Copyright (c) 2018 Daniel Miessler

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
