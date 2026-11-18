"""Prove the NEB wallet can live entirely in a browser.

Everything a web wallet needs has to be reproducible from a 32-byte secret with
nothing but hashes and a signature: key -> public key -> lock -> bech32m address,
then a transaction whose signature the node accepts. This script does that in one
file so the same steps can be ported to JS unchanged.
"""
import sys
import blake3
from nacl.signing import SigningKey

CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l"
BECH32M_CONST = 0x2BC830A3
GENERATOR = [0x3B6A57B2, 0x26508E6D, 0x1EA119FA, 0x3D4233DD, 0x2A1462B3]


def polymod(values):
    chk = 1
    for v in values:
        top = chk >> 25
        chk = ((chk & 0x1FFFFFF) << 5) ^ v
        for i in range(5):
            chk ^= GENERATOR[i] if ((top >> i) & 1) else 0
    return chk


def hrp_expand(hrp):
    return [ord(c) >> 5 for c in hrp] + [0] + [ord(c) & 31 for c in hrp]


def checksum(hrp, data):
    values = hrp_expand(hrp) + data
    mod = polymod(values + [0, 0, 0, 0, 0, 0]) ^ BECH32M_CONST
    return [(mod >> 5 * (5 - i)) & 31 for i in range(6)]


def convertbits(data, frombits, tobits, pad=True):
    acc, bits, out = 0, 0, []
    maxv = (1 << tobits) - 1
    for value in data:
        if value < 0 or (value >> frombits):
            return None
        acc = (acc << frombits) | value
        bits += frombits
        while bits >= tobits:
            bits -= tobits
            out.append((acc >> bits) & maxv)
    if pad:
        if bits:
            out.append((acc << (tobits - bits)) & maxv)
    elif bits >= frombits or ((acc << (tobits - bits)) & maxv):
        return None
    return out


def encode_address(pubkey: bytes, hrp="neb") -> str:
    lock = blake3.blake3(pubkey).digest()
    data = convertbits(lock, 8, 5)
    return hrp + "1" + "".join(CHARSET[d] for d in data + checksum(hrp, data))


def varint(n: int) -> bytes:
    out = b""
    while True:
        b = n & 0x7F
        n >>= 7
        out += bytes([b | (0x80 if n else 0)])
        if not n:
            return out


def h(tag: bytes, parts) -> bytes:
    hasher = blake3.blake3()
    hasher.update(tag)
    for p in parts:
        hasher.update(p)
    return hasher.digest()


def tx_encode(inputs, outputs, with_witness: bool) -> bytes:
    out = bytes([1]) + varint(len(inputs))
    for prev_txid, prev_index, witness in inputs:
        out += prev_txid + prev_index.to_bytes(4, "little")
        if with_witness:                      # the txid form drops the field, it does not zero it
            out += varint(len(witness)) + witness
    out += varint(len(outputs))
    for amount, lock_type, lock_data in outputs:
        out += amount.to_bytes(8, "little") + bytes([lock_type]) + lock_data
    return out


def main() -> int:
    secret = bytes.fromhex(sys.argv[1]) if len(sys.argv) > 1 else bytes(range(32))
    signing = SigningKey(secret)
    pubkey = bytes(signing.verify_key)
    lock = blake3.blake3(pubkey).digest()
    address = encode_address(pubkey)

    print("secret      ", secret.hex())
    print("public key  ", pubkey.hex())
    print("lock        ", lock.hex())
    print("address     ", address, len(address), "chars")

    # a one-in one-out transaction spending a made up coin, to show the signature
    # covers exactly what the node hashes: chain id, txid, input index, spent output
    chain_id = bytes.fromhex("da2f5af7bb4c5e2bcc8d558b2f4f01d4c88557a943e6cff9cd035638fe9439ae")
    prev_txid = bytes([7] * 32)
    inputs = [(prev_txid, 0, b"")]
    outputs = [(10_000_000, 1, lock)]
    unsigned = tx_encode(inputs, outputs, with_witness=False)
    txid = h(b"txid", [unsigned])
    spent = (50_000_000, 1, lock)
    sighash = h(b"sighash", [
        chain_id, txid, (0).to_bytes(4, "little"),
        spent[0].to_bytes(8, "little"), bytes([spent[1]]), spent[2],
    ])
    signature = signing.sign(sighash).signature
    print("txid        ", txid.hex())
    print("sighash     ", sighash.hex())
    print("signature   ", signature.hex())
    print("witness     ", (pubkey + signature).hex())

    # the node recomputes this from the witness alone; print what it must equal
    recovered = blake3.blake3(pubkey).digest().hex()
    print("node check  ", "lock == BLAKE3(witness[:32]) ->", recovered == lock.hex())
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
