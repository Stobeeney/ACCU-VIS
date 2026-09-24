// Self-signed HTTPS certificate + private key for the ESP8266 rail
// controller. This lets a browser page loaded over HTTPS (e.g. the
// deployed Vercel app) call this device's API without being blocked by
// "mixed content" -- both sides are HTTPS.
//
// This is a LOCAL-ONLY, self-signed cert for CN=192.168.4.1 (the fixed
// Access Point IP). Browsers will show a one-time untrusted-certificate
// warning the first time each device visits https://192.168.4.1 -- that's
// expected and safe to accept (same reasoning as the LAN camera server's
// self-signed cert). It has no relation to any real domain or public CA.
//
// To regenerate (10-year validity), run this in one line:
//   openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 3650 -nodes -subj "/CN=192.168.4.1" -addext "subjectAltName=IP:192.168.4.1"
//   openssl rsa -in key.pem -traditional -out key_traditional.pem
// Then paste cert.pem into SSL_CERT below and key_traditional.pem into
// SSL_KEY below (keep the BEGIN/END lines).

#pragma once

static const char SSL_CERT[] PROGMEM = R"EOF(
-----BEGIN CERTIFICATE-----
MIIDHjCCAgagAwIBAgIUR6HmIoMJq5Nu9kIncNWTv6mRaLYwDQYJKoZIhvcNAQEL
BQAwFjEUMBIGA1UEAwwLMTkyLjE2OC40LjEwHhcNMjYwOTI0MDgzNjA0WhcNMzYw
OTIxMDgzNjA0WjAWMRQwEgYDVQQDDAsxOTIuMTY4LjQuMTCCASIwDQYJKoZIhvcN
AQEBBQADggEPADCCAQoCggEBALkRNB9QDtqRTdLbC/KTvu4yTiaf70/jZ/DXQi5R
9/n480O5yn9L1W0hsQahQeR1bObCtP/8nE2nFpJgfegk8Eyuix4DbFZw2eRzQnxk
P0Y4hfbdJ48zJNyqelfCI6Ce8Lz7Mj/Rzey0oihxRQqCvKgbK3v9toFQLme69D/Y
3fxLRICb33oCbA0RRYmnZBjwkJdfo+R//9HuSt3176towSoaLUZmiewfHA1bhAP2
HJhR/u7G60IVVXCe1bFzTDhS5o+0SNol2EMwB2FvDI2Fw0mYvqLWJP7mf4n2DfXo
2/iUyrbTsVZa6Lfe6nhTEfVAMZpJs030hBiYZ37hyNWw6b0CAwEAAaNkMGIwHQYD
VR0OBBYEFKq9TQgj5pTZX0S2igbDOxGa/vmyMB8GA1UdIwQYMBaAFKq9TQgj5pTZ
X0S2igbDOxGa/vmyMA8GA1UdEwEB/wQFMAMBAf8wDwYDVR0RBAgwBocEwKgEATAN
BgkqhkiG9w0BAQsFAAOCAQEAJa5iFtoEPy5j92CDecwxjwfGh4ForuXHQc9QNAwK
j8+unORn35qeOjpDbONEh/xDchcFfFpHwePMDxWGVzVZbH6plqVtWYZYNDF+n2EB
WoIVAynP8dpWeiIg8BNK9DIrjQX22OvOEsW0n1c1T8CSykwAXAjw68oc8DsbPw9X
HFPmtuRJUHhs1c86GgJo+TSb2awh3V4Ydvs3nJRRILSdTduuBg+cXnWX2u4MqsoF
2E6AgNjDBGyFBYlU7Fo0OIocjmR1/V5maN7Sal+fkkkSnGZKDNffq+OEXxq+xiTa
DQTQTHeOKQe3I+wGg8P0JUZLz7Tt+EhI59pYXw4utPINsQ==
-----END CERTIFICATE-----
)EOF";

static const char SSL_KEY[] PROGMEM = R"EOF(
-----BEGIN RSA PRIVATE KEY-----
MIIEowIBAAKCAQEAuRE0H1AO2pFN0tsL8pO+7jJOJp/vT+Nn8NdCLlH3+fjzQ7nK
f0vVbSGxBqFB5HVs5sK0//ycTacWkmB96CTwTK6LHgNsVnDZ5HNCfGQ/RjiF9t0n
jzMk3Kp6V8IjoJ7wvPsyP9HN7LSiKHFFCoK8qBsre/22gVAuZ7r0P9jd/EtEgJvf
egJsDRFFiadkGPCQl1+j5H//0e5K3fXvq2jBKhotRmaJ7B8cDVuEA/YcmFH+7sbr
QhVVcJ7VsXNMOFLmj7RI2iXYQzAHYW8MjYXDSZi+otYk/uZ/ifYN9ejb+JTKttOx
Vlrot97qeFMR9UAxmkmzTfSEGJhnfuHI1bDpvQIDAQABAoIBACptU74z+9vGwQks
d446qeRwuvLm6pWthCg2KTF2UDvKA3cM0mwhhgHZXfyvnmwSMY+rppQjJPA2dJnF
Lkg4o7BouXL9hOpCP+m8NMtQriLalXe1VrrhFjvSh260DrfliDpC+k+gOS3hcWWF
JjdVJowBgpQP47W8nI7iUNmMTcPnVp6ZmTrxuTxjETYyzE5T2fAYRvZhPpYrjFa5
Ykxdr5sLykh7YNZaoLYV9rgtjRU0rTmcmPBh7ODqqa/eNolPcIxw4NDYlmRFMLo0
5JicRIwVziB/TWdX8nBI9HOoAMN75K4Oo6q/KA7Es10tuTTRRKbvn8sGD69q/Avo
FbFgmc8CgYEA/EltDWcaDaOHvuaKPIo2+DHQmrUxk5jo42EoSfj+R7vypzJ/yJW9
iXykVHx60wO0wTcQMRaQUn3oKAC0qznIssFFe0X74p5qemBIzYfaLUyC1p3XTsIP
R1kPNswDTOYScPr5WyNFlb6PbIcRRswASTJF3FlxYjnSldxNMIU0GecCgYEAu8qB
ZveNeNibtGYhuInxYmspLT6r/flyaPlJBmwSQ8eRRQkuY7sJ5eg5W2+WqhWIvppe
DmbeP3sz1eJufQQyeMgYetwjOaO47v8g1MjyN7t2h6sS/tjkt8yn0XzimHGiY6a4
Is3IKsWixonWmq9YgQCtouPz9b1u8D9IzfY6UrsCgYAtCCYxCEA8Qv5N8vSlzb32
G14y3zjUMa0QOR1p5snsn/22Hmt0sFW+nsLuWbHKzJSNEHkRagek0diIm2ekUJIk
Zh8y29EUKFa1NU6JcUBeaZPJHy95XWZAxALVMyE7rq2IASRVQjx/eB49rvZEftFm
P1T8+fIlKFEQctxMVtpv7QKBgBM0PFN5UWBgVlv2bdBfWu4Do2xbEl+gmNCfXZZo
it2flP2IWNQeFn8KZoMxQCkYlqlXQ/MZFfVL9hsTUtU6DqdHXymBRaDpW0olkQfx
nMOSSibJmeGx8IHTTf4gVVPdmwuxyvbUMHofR+whwG6FK/nVRex4f0RMIQI0lo9p
dMFtAoGBAO0WdDyxdUA/FEnnKgF5yzm4V66ZVVTvcvkqGh2FhBCxsU7xPVwj7piE
dTtfi+OOJ1wce38SRLu7iqc5DYzzotX164enX041OWRO2zo5jzwfcA6dx70cwtpo
JdP0mlhIFtEkScR2p5EW3w3zXqa4W25BIFDIyfy7Pt1zrscqlYc4
-----END RSA PRIVATE KEY-----
)EOF";
