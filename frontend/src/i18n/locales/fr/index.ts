import { api_keys } from "./api-keys";
import { auth } from "./auth";
import { avatars } from "./avatars";
import { common } from "./common";
import { lab } from "./lab";
import { landing } from "./landing";
import { members } from "./members";
import { settings } from "./settings";
import { share } from "./share";
import { simulator } from "./simulator";
import { voices } from "./voices";

export const messages = {
  ...api_keys,
  ...auth,
  ...avatars,
  ...common,
  ...lab,
  ...landing,
  ...members,
  ...settings,
  ...share,
  ...simulator,
  ...voices,
};
