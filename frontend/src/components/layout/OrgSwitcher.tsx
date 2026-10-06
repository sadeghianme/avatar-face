import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "@/components/ui/Button";
import { Input } from "@/components/ui/Input";
import { Select } from "@/components/ui/Select";
import { useOrg } from "@/providers/org";

export function OrgSwitcher() {
  const { t } = useTranslation();
  const { orgs, current, setCurrent, createOrg, loading } = useOrg();
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState("");

  if (creating) {
    return (
      <form
        className="mb-2 flex flex-col gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          if (!name.trim()) return;
          void createOrg(name.trim()).then(() => {
            setName("");
            setCreating(false);
          });
        }}
      >
        <Input autoFocus placeholder={t("newOrgName")} value={name} onChange={(e) => setName(e.target.value)} />
        <div className="flex gap-2">
          <Button type="submit" className="flex-1 py-1">
            {t("create")}
          </Button>
          <Button variant="secondary" className="flex-1 py-1" onClick={() => setCreating(false)}>
            {t("cancel")}
          </Button>
        </div>
      </form>
    );
  }

  return (
    <div className="mb-2">
      <Select
        aria-label="organization"
        disabled={loading && orgs.length === 0}
        value={current?.id ?? ""}
        onChange={(e) => {
          if (e.target.value === "__new__") setCreating(true);
          else {
            const org = orgs.find((o) => o.id === e.target.value);
            if (org) setCurrent(org);
          }
        }}
      >
        {orgs.length === 0 && <option value="">{t("loading")}</option>}
        {orgs.map((org) => (
          <option key={org.id} value={org.id}>
            {org.name}
          </option>
        ))}
        <option value="__new__">＋ {t("createOrg")}</option>
      </Select>
    </div>
  );
}
