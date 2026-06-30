#pragma once

class CHL2MP_Player;
class CBasePlayer;
class CBaseEntity;

void OpenVibeJS_ServerInit();
void OpenVibeJS_ServerShutdown();
void OpenVibeJS_ServerThink();

void OpenVibeJS_Server_PlayerInitialSpawn(CHL2MP_Player *player);
void OpenVibeJS_Server_PlayerSpawn(CHL2MP_Player *player);
void OpenVibeJS_Server_PlayerDeath(CHL2MP_Player *victim, CBaseEntity *attacker, CBaseEntity *inflictor);
void OpenVibeJS_Server_PlayerDisconnected(CHL2MP_Player *player);
bool OpenVibeJS_Server_PlayerSay(CHL2MP_Player *player, const char *text);

void OpenVibeJS_Server_RoundStart(int roundNumber);
void OpenVibeJS_Server_RoundEnd(int roundNumber, const char *reason);

void OpenVibeJS_Server_ConsoleCommand(const char *text);
void OpenVibeJS_Server_FireHook(const char *hookName);
