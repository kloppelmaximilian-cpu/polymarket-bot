# Sky Heist - persistent player progress.
#
# Fortnite persists a module-scoped `var weak_map(player, t)` whose value type
# is <persistable>. Every field needs a default so that `heist_save{}` is a
# valid fresh save, and the class is <final> as persistable classes must be.
# Keep the record small: a handful of ints and two 3-element arrays.
#
# Versioning: bump CurrentSaveVersion when fields change meaning. New fields
# must always get a default so older saves keep loading.

using { /Verse.org/Simulation }

CurrentSaveVersion:int = 1

heist_save := class<final><persistable>:
    Version:int = 1
    TotalXP:int = 0
    LifetimeBanked:int = 0
    LifetimeSteals:int = 0
    LifetimeVaultRobs:int = 0
    RoundsPlayed:int = 0
    RoundsWon:int = 0
    BestRoundBanked:int = 0
    TutorialDone:logic = false
    # UTC day the contract progress below belongs to (-1 = none yet).
    ContractDay:int = -1
    ContractProgress:[]int = array{}
    # 1 = reward already paid out for that contract slot today.
    ContractClaimed:[]int = array{}

var HeistSaves:weak_map(player, heist_save) = map{}

# Returns the stored save, or a fresh one for first-time players.
LoadHeistSave(Player:player)<transacts>:heist_save =
    if (Existing := HeistSaves[Player]):
        Existing
    else:
        heist_save{}

# Writes the save. Fails silently (no write) if the player already left the
# session, which is the documented behaviour of persistent weak_maps.
StoreHeistSave(Player:player, Save:heist_save)<transacts>:void =
    if (set HeistSaves[Player] = Save) {}
