import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useOrg } from "@/providers/org";

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { orgs, current, setCurrent, createOrg } = useOrg();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  if (creating) {
    return (
      <form
        className="mb-2 flex flex-col gap-2"
        onSubmit={async (e) => {
          e.preventDefault();
          if (!name.trim()) return;
          await createOrg(name.trim());
          setName("");
          setCreating(false);
        }}
      >
        <input
          autoFocus
          className="input"
          placeholder={t("newOrgName")}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="flex gap-2">
          <button type="submit" className="btn-primary flex-1 py-1">
            {t("create")}
          </button>
          <button
            type="button"
            className="btn-secondary flex-1 py-1"
            onClick={() => setCreating(false)}
          >
            {t("cancel")}
          </button>
        </div>
      </form>
    );
  }

  return (
    <div className="mb-2">
      <select
        aria-label="organization"
        className="input"
        value={current?.id ?? ""}
        onChange={(e) => {
          if (e.target.value === "__new__") setCreating(true);
          else {
            const org = orgs.find((o) => o.id === e.target.value);
            if (org) setCurrent(org);
          }
        }}
      >
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
        <option value="__new__">＋ {t("createOrg")}</option>
      </select>
    </div>
  );
}
