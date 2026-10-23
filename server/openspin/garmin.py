"""Garmin Connect link via the unofficial python-garminconnect package (optional extra [garmin]).

Tokens live in a directory created by `openspin login-garmin`. Nothing here runs unless the
page asks for an upload or HR zones. FIT files are always saved locally first.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import Any


class GarminError(Exception):
    pass


DISABLED_MSG = "Garmin is disabled for this server (OPENSPIN_GARMIN=off, or a non-default data dir without OPENSPIN_GARMIN_TOKENS)"


class GarminLink:
    def __init__(self, tokens: Path, enabled: bool = True):
        self.tokens = Path(tokens)
        self.enabled = enabled
        self._client = None

    def linked(self) -> bool:
        return self.enabled and self.tokens.exists() and any(self.tokens.iterdir())

    def client(self):
        if not self.enabled:
            raise GarminError(DISABLED_MSG)
        if self._client is None:
            try:
                from garminconnect import Garmin
            except ImportError as e:  # pragma: no cover - depends on install
                raise GarminError("garminconnect not installed: pip install 'openspin[garmin]'") from e
            g = Garmin()
            g.login(str(self.tokens))
            self._client = g
        return self._client

    def reset(self) -> None:
        self._client = None

    def zones(self) -> dict[str, Any]:
        zs = self.client().get_heart_rate_zones()
        z = next((x for x in zs if x.get("sport") == "CYCLING"), zs[0])
        return {
            "floors": [z[f"zone{i}Floor"] for i in range(1, 6)],
            "max": z.get("maxHeartRateUsed"),
            "lthr": z.get("lactateThresholdHeartRateUsed"),
        }

    def profile(self) -> dict[str, Any]:
        """FTP, weight and HR zones from the Garmin account, as far as the account has them.
        python-garminconnect exposes these through different calls across versions, so each piece
        is optional."""
        g = self.client()
        out: dict[str, Any] = {}
        try:
            out.update(self.zones())
        except Exception:  # noqa: BLE001
            pass
        data: dict = {}
        for fn in ("get_userprofile_settings", "get_user_profile"):
            if hasattr(g, fn):
                try:
                    res = getattr(g, fn)() or {}
                    data.update(res.get("userData") or res)
                except Exception:  # noqa: BLE001
                    pass
        w = data.get("weight")
        if isinstance(w, (int, float)) and w > 0:
            out["weight_kg"] = round(w / 1000, 1) if w > 1000 else round(float(w), 1)  # grams in the profile
        ftp = None
        for fn in ("get_cycling_ftp",):
            if hasattr(g, fn):
                try:
                    res = getattr(g, fn)()
                    res = res[0] if isinstance(res, list) and res else res
                    ftp = (res or {}).get("functionalThresholdPower") if isinstance(res, dict) else None
                except Exception:  # noqa: BLE001
                    pass
        ftp = ftp or data.get("functionalThresholdPower") or data.get("ftp")
        if isinstance(ftp, (int, float)) and 50 <= ftp <= 600:
            out["ftp"] = round(ftp)
        return out

    def upload(self, path: Path) -> dict[str, Any]:
        """Upload a FIT file. Returns {ok, duplicate?, activityId?, error?}."""
        if not self.enabled:
            return {"ok": False, "disabled": True, "error": DISABLED_MSG}
        try:
            res = self.client().upload_activity(str(path))
        except Exception as e:  # noqa: BLE001 - report any failure to the page
            msg = str(e)
            self.reset()
            if "409" in msg or "Duplicate" in msg:
                return {"ok": True, "duplicate": True}
            return {"ok": False, "error": msg[:300]}
        info: dict[str, Any] = {"ok": True}
        try:
            body = res.json() if hasattr(res, "json") else res
            det = body["detailedImportResult"]
            if det.get("failures"):
                f = det["failures"][0]
                if any(m.get("code") == 202 for m in f.get("messages", [])):
                    return {"ok": True, "duplicate": True}
                return {"ok": False, "error": json.dumps(f)[:300]}
            ok = det.get("successes") or []
            if ok:
                info["activityId"] = ok[0].get("internalId")
        except Exception:  # noqa: BLE001 - response shape varies; upload already succeeded
            pass
        return info


def interactive_login(tokens: Path) -> None:
    """One-time sign-in. Saves tokens for the server. Prompts on the terminal."""
    from getpass import getpass

    try:
        from garminconnect import Garmin
    except ImportError:
        raise SystemExit("garminconnect not installed: pip install 'openspin[garmin]'")
    try:
        g = Garmin()
        g.login(str(tokens))
        print("Already signed in.")
    except Exception:  # noqa: BLE001 - no or expired tokens
        email = input("Garmin email: ").strip()
        password = getpass("Garmin password: ")
        g = Garmin(email=email, password=password, prompt_mfa=lambda: input("MFA code: ").strip())
        g.login()
        tokens.mkdir(parents=True, exist_ok=True)
        g.client.dump(str(tokens))
        print(f"Signed in. Tokens saved to {tokens}")
    print("Account:", g.get_full_name())
