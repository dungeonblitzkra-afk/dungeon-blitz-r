import { strict as assert } from 'assert';
import * as path from 'path';
import { LevelConfig } from '../core/LevelConfig';
import { MissionLoader } from '../data/MissionLoader';
import { MissionID } from '../data/runtime';
import { MissionHandler } from '../handlers/MissionHandler';
import { NpcHandler } from '../handlers/NpcHandler';
import { BitBuffer } from '../network/protocol/bitBuffer';
import { BitReader } from '../network/protocol/bitReader';

type SentPacket = {
    id: number;
    payload: Buffer;
};

type FakeClient = {
    token: number;
    currentLevel: string;
    levelInstanceId: string;
    currentRoomId: number;
    playerSpawned: boolean;
    startedRoomEvents: Set<string>;
    userId: number | null;
    character: {
        name: string;
        level: number;
        xp?: number;
        gold?: number;
        CurrentLevel: { name: string; x: number; y: number };
        PreviousLevel: { name: string; x: number; y: number };
        missions: Record<string, Record<string, number>>;
        questTrackerState: number;
    };
    entities: Map<number, unknown>;
    pendingMissionTurnIns: Set<number>;
    sentPackets: SentPacket[];
    sendBitBuffer: (id: number, bb: BitBuffer) => void;
    send?: (id: number, payload: Buffer) => void;
    socket?: { destroyed: boolean };
};

function ensureDataLoaded(): void {
    const dataDir = path.resolve(__dirname, '../data');
    if (!LevelConfig.has('TutorialBoat')) {
        LevelConfig.load(dataDir);
    }
    if (!MissionLoader.getMissionDef(MissionID.ClearYourHouse)) {
        MissionLoader.load(dataDir);
    }
}

function createFakeClient(
    currentLevel: string,
    missions: Record<string, Record<string, number>>,
    questTrackerState: number
): FakeClient {
    const sentPackets: SentPacket[] = [];

    return {
        token: 7001,
        currentLevel,
        levelInstanceId: 'quest-flow',
        currentRoomId: 0,
        playerSpawned: true,
        startedRoomEvents: new Set<string>(),
        userId: null,
        character: {
            name: 'QuestFlowTester',
            level: 2,
            xp: 0,
            gold: 0,
            CurrentLevel: { name: currentLevel, x: 0, y: 0 },
            PreviousLevel: { name: 'NewbieRoad', x: 1421, y: 826 },
            missions,
            questTrackerState
        },
        entities: new Map(),
        pendingMissionTurnIns: new Set<number>(),
        sentPackets,
        sendBitBuffer(id: number, bb: BitBuffer): void {
            sentPackets.push({ id, payload: bb.toBuffer() });
        }
    };
}

function createLevelCompletePacket(
    completionPercent: number,
    bonusScoreTotal: number,
    goldReward: number,
    remainingKills: number,
    requiredKills: number,
    stars: number
): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(completionPercent);
    bb.writeMethod9(bonusScoreTotal);
    bb.writeMethod9(goldReward);
    bb.writeMethod9(0);
    bb.writeMethod9(0);
    bb.writeMethod9(remainingKills);
    bb.writeMethod9(requiredKills);
    bb.writeMethod9(stars);
    return bb.toBuffer();
}

function createNpcTalkPacket(npcId: number): Buffer {
    const bb = new BitBuffer(false);
    bb.writeMethod9(npcId);
    return bb.toBuffer();
}

function decodeStartSkitPacket(payload: Buffer): { npcId: number; dialogueId: number; missionId: number } {
    const br = new BitReader(payload);
    return {
        npcId: br.readMethod4(),
        dialogueId: br.readMethod6(3),
        missionId: br.readMethod4()
    };
}

async function testTutorialBoatCompletionPersistsDungeonHoverStats(): Promise<void> {
    const client = createFakeClient(
        'TutorialBoat',
        {
            [String(MissionID.DefendTheShip)]: {
                state: 1,
                currCount: 0
            }
        },
        0
    );

    await MissionHandler.handleSetLevelComplete(
        client as never,
        createLevelCompletePacket(100, 209, 155, 0, 1, 5)
    );

    const mission = client.character.missions[String(MissionID.DefendTheShip)];
    assert.equal(Number(mission?.state ?? 0), 2, 'Lost at Sea should become ready to turn in');
    assert.equal(Number(mission?.Tier ?? 0), 5, 'Lost at Sea should persist the completed star count');
    assert.equal(Number(mission?.highscore ?? 0), 209, 'Lost at Sea should persist the completed total score');
    assert.equal(Number(mission?.Time ?? 0) > 0, true, 'Lost at Sea should persist completion time metadata');
}

async function testRescueAnnaCompletionLeavesFindAnnasFatherAvailableOnAnna(): Promise<void> {
    const client = createFakeClient(
        'TutorialDungeon',
        {
            [String(MissionID.MeetTheTown)]: {
                state: 3,
                currCount: 1,
                claimed: 1,
                complete: 1
            },
            [String(MissionID.RescueAnna)]: {
                state: 1,
                currCount: 0
            }
        },
        100
    );

    await MissionHandler.handleSetLevelComplete(
        client as never,
        createLevelCompletePacket(100, 209, 155, 0, 1, 5)
    );

    const rescueAnna = client.character.missions[String(MissionID.RescueAnna)];
    assert.equal(Number(rescueAnna?.state ?? 0), 3, 'Goblin Kidnappers should be marked claimed after completion');
    assert.equal(Number(rescueAnna?.Tier ?? 0), 5, 'Goblin Kidnappers should persist the completed star count');
    assert.equal(Number(rescueAnna?.highscore ?? 0), 209, 'Goblin Kidnappers should persist the completed total score');
    assert.equal(
        client.character.missions[String(MissionID.FindAnnasFather)],
        undefined,
        "Find Anna's Father should stay available until Anna offers it"
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        false,
        'dungeon completion should not auto-send a follow-up mission-added popup'
    );

    const nextMission = (NpcHandler as any).findBestMission(client.character, 'nranna03');
    assert.deepEqual(
        nextMission,
        {
            missionId: MissionID.FindAnnasFather,
            dialogueId: 2,
            state: 0
        },
        'Anna should advertise the next quest after Goblin Kidnappers is cleared'
    );
}

async function testCaptainFinkRepairsLostAtSeaTurnInForCurrentPlayer(): Promise<void> {
    const client = createFakeClient('CraftTown', {}, 100);
    client.character.CurrentLevel = { name: 'CraftTown', x: 360, y: 1460 };
    client.character.PreviousLevel = { name: 'NewbieRoad', x: 1421, y: 826 };
    client.character.level = 10;
    client.entities.set(77, { id: 77, characterName: 'CaptainFink' });

    const originalSetTimeout = global.setTimeout;
    (global as any).setTimeout = ((() => 0) as unknown) as typeof setTimeout;

    try {
        await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(77));
    } finally {
        (global as any).setTimeout = originalSetTimeout;
    }

    assert.equal(
        Number(client.character.missions[String(MissionID.DefendTheShip)]?.state ?? 0),
        2,
        'Captain Fink interaction should repair Goblin Assault into ready-to-turn-in for broken current players'
    );
    assert.equal(
        client.pendingMissionTurnIns.has(MissionID.DefendTheShip),
        true,
        'Captain Fink should immediately offer the repaired Lost at Sea turn-in flow'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x7B),
        true,
        'Captain Fink should start the mission turn-in dialogue after repairing the quest state'
    );
}

async function testCaptainFinkTurnInClaimsFirstThenOffersWashedAshoreOnSecondTalk(): Promise<void> {
    const client = createFakeClient(
        'NewbieRoad',
        {
            [String(MissionID.DefendTheShip)]: {
                state: 2,
                currCount: 1
            }
        },
        100
    );
    client.character.CurrentLevel = { name: 'NewbieRoad', x: 1421, y: 826 };
    client.entities.set(88, { id: 88, characterName: 'CaptainFink' });
    client.socket = { destroyed: false };

    const originalSetTimeout = global.setTimeout;
    (global as any).setTimeout = ((fn: (...args: any[]) => void) => {
        fn();
        return 0;
    }) as unknown as typeof setTimeout;

    try {
        await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(88));
    } finally {
        (global as any).setTimeout = originalSetTimeout;
    }

    assert.equal(
        Number(client.character.missions[String(MissionID.DefendTheShip)]?.state ?? 0),
        3,
        'first Captain Fink talk should only claim Goblin Assault'
    );
    assert.equal(
        client.character.missions[String(MissionID.MeetTheTown)],
        undefined,
        'Washed Ashore should not auto-start during the same Captain Fink reward turn-in'
    );
    assert.equal(
        client.sentPackets.some(
            (packet) =>
                packet.id === 0x85 &&
                Number(client.character.missions[String(MissionID.MeetTheTown)]?.state ?? 0) !== 0
        ),
        false,
        'claiming Goblin Assault should not send a Washed Ashore mission-added packet yet'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        true,
        'claiming Goblin Assault should still show the mission-complete reward UI'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(88));

    assert.equal(
        Number(client.character.missions[String(MissionID.MeetTheTown)]?.state ?? 0),
        2,
        'the second Captain Fink talk should accept Washed Ashore'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        true,
        'accepting Washed Ashore on the second talk should send the mission-added packet'
    );

    client.sentPackets.length = 0;
    await NpcHandler.handleTalkToNpc(client as never, createNpcTalkPacket(88));

    const skitPacket = client.sentPackets.find((packet) => packet.id === 0x7B);
    assert.ok(
        skitPacket,
        'talking to Captain Fink after accepting Washed Ashore should still start a mission skit'
    );
    assert.deepEqual(
        decodeStartSkitPacket(skitPacket!.payload),
        {
            npcId: 88,
            dialogueId: 3,
            missionId: MissionID.MeetTheTown
        },
        'Captain Fink should continue with Washed Ashore active dialogue after the mission is accepted'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x85),
        false,
        're-talking to Captain Fink after accepting Washed Ashore should not re-add the mission'
    );
    assert.equal(
        client.sentPackets.some((packet) => packet.id === 0x84),
        false,
        're-talking to Captain Fink after accepting Washed Ashore should not show reward UI'
    );
}

async function main(): Promise<void> {
    ensureDataLoaded();
    await testTutorialBoatCompletionPersistsDungeonHoverStats();
    await testRescueAnnaCompletionLeavesFindAnnasFatherAvailableOnAnna();
    await testCaptainFinkRepairsLostAtSeaTurnInForCurrentPlayer();
    await testCaptainFinkTurnInClaimsFirstThenOffersWashedAshoreOnSecondTalk();
    console.log('quest_flow_regression: ok');
}

void main().catch((error) => {
    console.error('quest_flow_regression: failed');
    console.error(error);
    process.exitCode = 1;
});
