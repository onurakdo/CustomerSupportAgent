import os
from typing import Optional
from bedrock_agentcore.memory.integrations.strands.config import AgentCoreMemoryConfig, RetrievalConfig
from bedrock_agentcore.memory.integrations.strands.session_manager import AgentCoreMemorySessionManager

# AgentCore deploys the memory ID under MEMORY_AGENTMEMORY_ID. Some older
# examples and staging copies still use MEMORY_SHAREDMEMORY_ID, so keep both as
# a compatibility fallback.
MEMORY_ID = os.getenv("MEMORY_AGENTMEMORY_ID") or os.getenv("MEMORY_SHAREDMEMORY_ID")
REGION = os.getenv("AWS_REGION") or os.getenv("AWS_DEFAULT_REGION")


def get_memory_session_manager(session_id: str, actor_id: str) -> Optional[AgentCoreMemorySessionManager]:
    if not MEMORY_ID:
        return None

    retrieval_config = {
        f"/users/{actor_id}/facts": RetrievalConfig(top_k=3, relevance_score=0.3),
        f"/summaries/{actor_id}/{session_id}": RetrievalConfig(top_k=3, relevance_score=0.3)
    }

    return AgentCoreMemorySessionManager(
        AgentCoreMemoryConfig(
            memory_id=MEMORY_ID,
            session_id=session_id,
            actor_id=actor_id,
            retrieval_config=retrieval_config,
        ),
        REGION
    )