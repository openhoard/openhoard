from openhoard.cli import validate_manifest

BASE = {
    "manifest_version": 1,
    "name": "enricher-invoice",
    "version": "1.2.0",
    "type": "enricher",
    "runtime": "wasm",
    "accepts": ["application/pdf"],
    "capabilities": ["read:content", "write:fields", "propose:tags"],
    "network": [],
    "max_exposure": "commercial-only",
}


def test_valid_enricher():
    assert validate_manifest(BASE)[0]


def test_core_only_capabilities_rejected():
    for cap in ("grant", "share", "policy:write", "audit:write"):
        assert not validate_manifest({**BASE, "capabilities": [cap]})[0], cap


def test_enricher_requires_accepts():
    m = dict(BASE)
    m.pop("accepts")
    assert not validate_manifest(m)[0]


def test_pack_cannot_request_capabilities_or_network():
    pack = {"manifest_version": 1, "name": "pack-legal", "version": "0.1.0", "type": "pack",
            "capabilities": [], "network": []}
    assert validate_manifest(pack)[0]
    assert not validate_manifest({**pack, "capabilities": ["read:content"]})[0]
    assert not validate_manifest({**pack, "network": ["example.com"]})[0]


def test_unknown_fields_rejected():
    assert not validate_manifest({**BASE, "sneaky": True})[0]
