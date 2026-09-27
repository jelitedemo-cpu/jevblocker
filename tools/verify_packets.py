"""Cross-check of the Kotlin packet logic in app/src/main/java/com/jev/blocker/dns/.

Mirrors DnsPacket.kt and IpPacket.kt byte for byte so the offsets and checksums
can be exercised without an Android toolchain.
"""

HEADER_SIZE = 12
MIN_QUERY_SIZE = 17
PROTO_UDP = 17
FAILURES = []


def check(label, got, want):
    ok = got == want
    if not ok:
        FAILURES.append(f"{label}: got {got!r}, want {want!r}")
    print(f"  {'ok  ' if ok else 'FAIL'} {label}")


def dns_query(name, txid=0x1234):
    out = bytearray(12)
    out[0] = (txid >> 8) & 0xFF
    out[1] = txid & 0xFF
    out[2] = 0x01
    out[3] = 0
    out[5] = 1
    for label in name.split("."):
        out.append(len(label))
        out.extend(label.encode("ascii"))
    out.append(0)
    out.extend(b"\x00\x01\x00\x01")
    return bytes(out)


def question_length(buf, offset, length):
    if length < MIN_QUERY_SIZE:
        return -1
    end = offset + length
    if end > len(buf):
        return -1
    i = offset + HEADER_SIZE
    while i < end:
        label_len = buf[i]
        if label_len == 0:
            question_end = i + 5
            return question_end - offset if question_end <= end else -1
        if label_len > 63:
            return -1
        i += label_len + 1
    return -1


def question_name(buf, offset, length):
    if length < MIN_QUERY_SIZE:
        return None
    end = offset + length
    if end > len(buf):
        return None
    parts = []
    i = offset + HEADER_SIZE
    while i < end:
        label_len = buf[i]
        if label_len == 0:
            return None if not parts else ".".join(parts)
        if label_len > 63 or i + 1 + label_len > end:
            return None
        parts.append(buf[i + 1:i + 1 + label_len].decode("ascii", "replace"))
        i += label_len + 1
        if sum(len(p) for p in parts) + len(parts) - 1 > 253:
            return None
    return None


def nx_domain(query, offset, length):
    qlen = question_length(query, offset, length)
    if qlen < 0:
        return None
    out = bytearray(query[offset:offset + HEADER_SIZE + qlen])
    out[2] = 0x81
    out[3] = 0x80 | 3
    for i in range(6, 12):
        out[i] = 0
    out[HEADER_SIZE:HEADER_SIZE + qlen] = query[offset + HEADER_SIZE:offset + HEADER_SIZE + qlen]
    return bytes(out)


def u16(buf, i):
    return (buf[i] << 8) | buf[i + 1]


def checksum(buf, offset, length):
    total = 0
    i = offset
    end = offset + length
    while i + 1 < end:
        total += u16(buf, i)
        i += 2
    if i < end:
        total += buf[i] << 8
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return (~total) & 0xFFFF


def parse_udp4(buf, length):
    ihl = (buf[0] & 0x0F) * 4
    if ihl < 20 or length < ihl + 8:
        return None
    if buf[9] != PROTO_UDP:
        return None
    total_len = u16(buf, 2)
    udp_len = u16(buf, ihl + 4)
    if udp_len < 8:
        return None
    payload_offset = ihl + 8
    payload_length = min(udp_len - 8, length - payload_offset)
    if total_len >= payload_offset:
        payload_length = min(payload_length, total_len - payload_offset)
    if payload_length <= 0:
        return None
    return {
        "version": 4,
        "src": bytes(buf[12:16]),
        "dst": bytes(buf[16:20]),
        "src_port": u16(buf, ihl),
        "dst_port": u16(buf, ihl + 2),
        "offset": payload_offset,
        "length": payload_length,
    }


def parse_udp6(buf, length):
    if length < 48:
        return None
    if buf[6] != PROTO_UDP:
        return None
    payload_len = u16(buf, 4)
    if payload_len < 8:
        return None
    payload_offset = 48
    payload_length = min(payload_len - 8, length - payload_offset)
    if payload_length <= 0:
        return None
    return {
        "version": 6,
        "src": bytes(buf[8:24]),
        "dst": bytes(buf[24:40]),
        "src_port": u16(buf, 40),
        "dst_port": u16(buf, 42),
        "offset": payload_offset,
        "length": payload_length,
    }


def write_udp_header(p, offset, src_port, dst_port, udp_len):
    p[offset] = (src_port >> 8) & 0xFF
    p[offset + 1] = src_port & 0xFF
    p[offset + 2] = (dst_port >> 8) & 0xFF
    p[offset + 3] = dst_port & 0xFF
    p[offset + 4] = (udp_len >> 8) & 0xFF
    p[offset + 5] = udp_len & 0xFF
    p[offset + 6] = 0
    p[offset + 7] = 0


def build_reply4(req, payload):
    udp_len = 8 + len(payload)
    total = 20 + udp_len
    p = bytearray(total)
    p[0] = 0x45
    p[2] = (total >> 8) & 0xFF
    p[3] = total & 0xFF
    p[6] = 0x40
    p[8] = 64
    p[9] = PROTO_UDP
    p[12:16] = req["dst"]
    p[16:20] = req["src"]
    header = checksum(p, 0, 20)
    p[10] = (header >> 8) & 0xFF
    p[11] = header & 0xFF
    write_udp_header(p, 20, req["dst_port"], req["src_port"], udp_len)
    p[26] = 0
    p[27] = 0
    p[28:28 + len(payload)] = payload
    return bytes(p)


def checksum6(src, dst, udp, offset, udp_len):
    total = 0
    for i in range(0, 16, 2):
        total += u16(src, i)
    for i in range(0, 16, 2):
        total += u16(dst, i)
    total += udp_len & 0xFFFF
    total += PROTO_UDP
    i = offset
    end = offset + udp_len
    while i + 1 < end:
        total += u16(udp, i)
        i += 2
    if i < end:
        total += udp[i] << 8
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    folded = (~total) & 0xFFFF
    return 0xFFFF if folded == 0 else folded


def build_reply6(req, payload):
    udp_len = 8 + len(payload)
    p = bytearray(40 + udp_len)
    p[0] = 0x60
    p[4] = (udp_len >> 8) & 0xFF
    p[5] = udp_len & 0xFF
    p[6] = PROTO_UDP
    p[7] = 64
    p[8:24] = req["dst"]
    p[24:40] = req["src"]
    write_udp_header(p, 40, req["dst_port"], req["src_port"], udp_len)
    p[48:48 + len(payload)] = payload
    value = checksum6(req["dst"], req["src"], p, 40, udp_len)
    p[46] = (value >> 8) & 0xFF
    p[47] = value & 0xFF
    return bytes(p)


def verify_udp6(src, dst, udp, offset, udp_len):
    """Recompute the checksum with the field zeroed and compare to what is stored."""
    body = bytearray(udp[offset:offset + udp_len])
    stored = (body[6] << 8) | body[7]
    body[6] = 0
    body[7] = 0
    return stored == checksum6(src, dst, body, 0, udp_len)


def fold(buf, offset, length):
    total = 0
    i = offset
    end = offset + length
    while i + 1 < end:
        total += u16(buf, i)
        i += 2
    if i < end:
        total += buf[i] << 8
    while total >> 16:
        total = (total & 0xFFFF) + (total >> 16)
    return total & 0xFFFF


def ipv4_udp(src, dst, src_port, dst_port, payload):
    udp_len = 8 + len(payload)
    total = 20 + udp_len
    p = bytearray(total)
    p[0] = 0x45
    p[2] = (total >> 8) & 0xFF
    p[3] = total & 0xFF
    p[8] = 64
    p[9] = PROTO_UDP
    p[12:16] = bytes(src)
    p[16:20] = bytes(dst)
    value = checksum(p, 0, 20)
    p[10] = (value >> 8) & 0xFF
    p[11] = value & 0xFF
    write_udp_header(p, 20, src_port, dst_port, udp_len)
    p[28:28 + len(payload)] = payload
    return bytes(p)


print("DnsPacket")
query = dns_query("ads.tracker.example.com")
check("questionName", question_name(query, 0, len(query)), "ads.tracker.example.com")

small = dns_query("a.io")
check("questionLength", question_length(small, 0, len(small)), 12 + 2 + 3 + 1 + 4)

reply = nx_domain(query, 0, len(query))
check("nxDomain size", len(reply), len(query))
check("nxDomain txid", (reply[0], reply[1]), (query[0], query[1]))
check("nxDomain flags hi", reply[2], 0x81)
check("nxDomain flags lo", reply[3], 0x83)
check("nxDomain rcode", reply[3] & 0x0F, 3)
check("nxDomain counts zeroed", list(reply[6:12]), [0] * 6)
check("nxDomain echoes question", reply[12:], query[12:])
check("truncated rejected", question_name(query, 0, 12), None)
check("truncated length rejected", question_length(query, 0, 12), -1)

print("IpPacket IPv4")
packet = ipv4_udp([192, 168, 1, 50], [8, 8, 8, 8], 40000, 53, bytes(range(20)))
req = parse_udp4(packet, len(packet))
check("version", req["version"], 4)
check("src port", req["src_port"], 40000)
check("dst port", req["dst_port"], 53)
check("payload length", req["length"], 20)
check("payload offset", req["offset"], 28)
check("src ip first octet", req["src"][0], 192)
check("dst ip first octet", req["dst"][0], 8)

tcp = bytearray(packet)
tcp[9] = 6
check("non-UDP ignored", parse_udp4(bytes(tcp), len(tcp)), None)

answer = build_reply4(req, bytes(12))
check("reply size", len(answer), 20 + 8 + 12)
check("reply src ip", answer[12], 8)
check("reply dst ip", answer[16], 192)
check("reply src port", u16(answer, 20), 53)
check("reply dst port", u16(answer, 22), 40000)
check("ipv4 header checksum valid", fold(answer, 0, 20), 0xFFFF)

print("IpPacket IPv6")
src = bytes([0x20] * 16)
dst = bytes([0x30] * 16)
payload = bytes(range(24))
header = bytearray(48 + len(payload))
header[0] = 0x60
header[4] = 0
header[5] = 8 + len(payload)
header[6] = PROTO_UDP
header[7] = 64
header[8:24] = src
header[24:40] = dst
header[40] = 0
header[41] = 53
header[42] = 0x9C
header[43] = 0x40
header[44] = 0
header[45] = 8 + len(payload)
header[48:48 + len(payload)] = payload

req6 = parse_udp6(bytes(header), len(header))
check("version", req6["version"], 6)
check("src port", req6["src_port"], 53)
check("dst port", req6["dst_port"], 40000)
check("payload length", req6["length"], 24)

answer6 = build_reply6(req6, payload)
check("reply size", len(answer6), 40 + 8 + 24)
check("reply src ip", answer6[8], 0x30)
check("reply dst ip", answer6[24], 0x20)
check("reply src port", u16(answer6, 40), 40000)
check("reply dst port", u16(answer6, 42), 53)
udp_sum = u16(answer6, 46)
check("ipv6 checksum non-zero", udp_sum != 0, True)
check("ipv6 udp checksum valid", verify_udp6(dst, src, answer6, 40, 8 + 24), True)

corrupted = bytearray(answer6)
corrupted[60] ^= 0xFF
check(
    "ipv6 corrupted payload detected",
    verify_udp6(dst, src, bytes(corrupted), 40, 8 + 24),
    False,
)

print()
if FAILURES:
    print(f"{len(FAILURES)} FAILURE(S)")
    for f in FAILURES:
        print("  " + f)
    raise SystemExit(1)
print("all checks passed")
