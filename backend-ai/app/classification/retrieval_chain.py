from __future__ import annotations
from typing import List, Dict, Optional, Any, Callable
from dataclasses import dataclass

from langchain_core.vectorstores import VectorStore
from langchain_core.runnables import RunnablePassthrough, RunnableLambda
from langchain_core.output_parsers import JsonOutputParser
from langchain_core.prompts import ChatPromptTemplate
from langchain_core.documents import Document

from ..defaults import QUADRANT_NAMES
from ..domain.events import event_publisher, VectorItemAddedEvent, DomainEvent
from ..vector.langchain_adapter import EisenhowerEmbeddings


@dataclass(frozen=True)
class EisenhowerClassificationResult:
    task: str
    quadrant: int
    quadrant_name: str
    confidence: float
    reasoning: str
    similar_examples: List[Dict[str, Any]]
    method: str = "langchain-retrieval-qa"


class QuadrantRetrievalQA:
    """
    DDD Retrieval QA Chain dla klasyfikacji zadań Eisenhowera
    Implementuje wzorzec Chain of Responsibility, reaguje na zdarzenia domenowe
    """

    SYSTEM_PROMPT = """
    Jesteś ekspertem od Macierzy Eisenhowera. Klasyfikuj zadanie do jednego z 4 kwadrantów:
    0 - PILNE I WAŻNE (wykonaj natychmiast)
    1 - WAŻNE NIE PILNE (zaplanuj)
    2 - PILNE NIE WAŻNE (zdeleguj)
    3 - ANI PILNE ANI WAŻNE (wyeliminuj)

    UżyJ TYLKO podanych podobnych przykładów aby określić klasyfikację.
    Zwróć TYLKO prawidłowy JSON bez żadnego dodatkowego tekstu:
    {{
        "quadrant": <liczba 0-3>,
        "confidence": <liczba zmiennoprzecinkowa 0.0-1.0>,
        "reasoning": "<krótki wyjaśnienie dlaczego ta klasyfikacja>"
    }}

    Podobne przykłady:
    {context}
    """

    def __init__(
        self,
        vector_store: VectorStore,
        embeddings: EisenhowerEmbeddings,
        top_k: int = 3
    ):
        self.vector_store = vector_store
        self.embeddings = embeddings
        self.top_k = top_k
        self._retriever = vector_store.as_retriever(search_kwargs={"k": top_k})
        self._chain = self._build_chain()
        self._subscribe_events()

    def _subscribe_events(self) -> None:
        """Odśwież retriever po każdej zmianie w bazie wektorów"""
        event_publisher.subscribe(self._handle_vector_event)

    def _handle_vector_event(self, event: DomainEvent) -> None:
        if isinstance(event, (VectorItemAddedEvent)):
            # Odśwież cache embeddingów automatycznie dzięki EisenhowerEmbeddings
            # oraz odbuduj retriever jeśli wymagane
            self._retriever = self.vector_store.as_retriever(search_kwargs={"k": self.top_k})

    def _format_context(self, documents: List[Document]) -> str:
        lines = []
        for doc in documents:
            quadrant = doc.metadata.get("quadrant", -1)
            quadrant_name = QUADRANT_NAMES.get(quadrant, "Nieznany")
            lines.append(f"- Zadanie: {doc.page_content} | Kwadrant: {quadrant} ({quadrant_name})")
        return "\n".join(lines)

    def _build_chain(self):
        prompt = ChatPromptTemplate.from_messages([
            ("system", self.SYSTEM_PROMPT),
            ("human", "Klasyfikuj zadanie: {task}")
        ])

        return (
            RunnablePassthrough.assign(
                context=RunnableLambda(lambda x: self._retriever.invoke(x["task"])) | self._format_context
            )
            | prompt
            | RunnableLambda(lambda x: x.to_string())
            | JsonOutputParser()
        )

    def classify(self, task: str) -> EisenhowerClassificationResult:
        """
        Klasyfikuje pojedyncze zadanie używając RAG z LangChain
        """
        # Pobierz podobne przykłady bezpośrednio z VectorStore
        similar_docs = self.vector_store.similarity_search(task, k=self.top_k)
        similar_examples = [
            {
                "text": doc.page_content,
                "quadrant": doc.metadata.get("quadrant"),
                "quadrant_name": QUADRANT_NAMES.get(doc.metadata.get("quadrant"))
            }
            for doc in similar_docs
        ]

        # Wykonaj łańcuch klasyfikacji
        result = self._chain.invoke({"task": task})

        quadrant = int(result.get("quadrant", 3))
        confidence = float(result.get("confidence", 0.0))
        reasoning = str(result.get("reasoning", "Brak wyjaśnienia"))

        return EisenhowerClassificationResult(
            task=task,
            quadrant=quadrant,
            quadrant_name=QUADRANT_NAMES[quadrant],
            confidence=confidence,
            reasoning=reasoning,
            similar_examples=similar_examples
        )

    async def aclassify(self, task: str) -> EisenhowerClassificationResult:
        """Asynchroniczna wersja klasyfikacji"""
        similar_docs = await self.vector_store.asimilarity_search(task, k=self.top_k)
        similar_examples = [
            {
                "text": doc.page_content,
                "quadrant": doc.metadata.get("quadrant"),
                "quadrant_name": QUADRANT_NAMES.get(doc.metadata.get("quadrant"))
            }
            for doc in similar_docs
        ]

        result = await self._chain.ainvoke({"task": task})

        quadrant = int(result.get("quadrant", 3))
        confidence = float(result.get("confidence", 0.0))
        reasoning = str(result.get("reasoning", "Brak wyjaśnienia"))

        return EisenhowerClassificationResult(
            task=task,
            quadrant=quadrant,
            quadrant_name=QUADRANT_NAMES[quadrant],
            confidence=confidence,
            reasoning=reasoning,
            similar_examples=similar_examples
        )
